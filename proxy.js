// proxy.js — GPT-прокси с поддержкой Assistants API (чат),
// fallback на Chat Completions, опциональной озвучкой (TTS),
// и отдельным /blog для длинных статей (строгий JSON).
// Совместимо с текущим плагином чата: формат ответа /chat не менялся.
//
// Требуемые ENV:
//   OPENAI_API_KEY (обязателен)
//
// Необязательно (если захочешь развести ключ/модель для блога):
//   OPENAI_API_KEY_BLOG, MODEL_BLOG
//
// package.json:
// { "type": "module", "dependencies": { "express","cors","openai" } }

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 10000;

// --- Клиент OpenAI по умолчанию (для /chat, /avatar и т.п.) -----------------
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Ассистент по умолчанию (опционально через ENV)
const DEFAULT_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || null;

// --- Middleware --------------------------------------------------------------
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// --- Health-check ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("OK: GPT proxy is alive");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "gpt-proxy" });
});

// --- /chat: главный эндпоинт для чата (ФОРМАТ ОТВЕТА НЕ МЕНЯЛ) --------------
app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const {
      model = "gpt-4o",
      messages = [],
      assistantId,        // может прийти asst_... → режим Assistants
      voice = false,      // если true — вернём audio (base64)
      tts_model,          // опционально переопределить TTS-модель
      tts_voice           // опционально выбрать голос
    } = body;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Отсутствует OPENAI_API_KEY на сервере.",
      });
    }

    // Выбираем ассистента, если передан реальный ID
    const rawAssistantId = assistantId || DEFAULT_ASSISTANT_ID;
    const effectiveAssistantId =
      rawAssistantId && rawAssistantId !== "asst_TEST" ? rawAssistantId : null;

    let answerText = "";

    // ===== 1) Режим Assistants API, если есть реальный asst_ ===============
    if (effectiveAssistantId) {
      const allMessages = Array.isArray(messages) ? messages : [];
      // Берём последнее user-сообщение
      const lastUser = [...allMessages].reverse().find(m => m.role === "user");
      const userContent =
        (lastUser && typeof lastUser.content === "string"
          ? lastUser.content
          : "") || "";

      if (!userContent.trim()) {
        throw new Error("Нет пользовательского текста для ассистента.");
      }

      // 1) Создаём thread
      const thread = await client.beta.threads.create();

      // 2) Добавляем сообщение пользователя
      await client.beta.threads.messages.create(thread.id, {
        role: "user",
        content: userContent,
      });

      // 3) Запускаем run для ассистента
      let run = await client.beta.threads.runs.create(thread.id, {
        assistant_id: effectiveAssistantId,
      });

      // 4) Ждём завершения run
      while (
        run.status === "queued" ||
        run.status === "in_progress" ||
        run.status === "cancelling"
      ) {
        await new Promise(r => setTimeout(r, 1000));
        run = await client.beta.threads.runs.retrieve(thread.id, run.id);
      }

      if (run.status !== "completed") {
        throw new Error("Ассистент не завершил ответ. Статус: " + run.status);
      }

      // 5) Забираем последнее сообщение ассистента
      const msgList = await client.beta.threads.messages.list(thread.id, {
        limit: 10,
      });

      const assistantMessages = msgList.data.filter(
        m => m.role === "assistant"
      );

      if (!assistantMessages.length) {
        throw new Error("Ассистент не вернул сообщений.");
      }

      const m = assistantMessages[0]; // самое свежее
      const textParts = (m.content || [])
        .filter(part => part.type === "text")
        .map(part => part.text.value);

      answerText = textParts.join("\n").trim();
    } else {
      // ===== 2) Старый режим: Chat Completions (fallback) ====================
      const completion = await client.chat.completions.create({
        model,
        messages,
      });

      answerText =
        completion.choices?.[0]?.message?.content?.trim() ||
        "Извини, я не смог сформировать ответ.";
    }

    if (!answerText) {
      answerText = "Извини, я не смог сформировать ответ.";
    }

    // === Опциональная озвучка (TTS) — возвращаем base64 в поле audio ========
    let audioBase64 = null;

    if (voice === true) {
      // Пытаемся сгенерировать речь через TTS-модель OpenAI
      // По умолчанию возьмём gpt-4o-mini-tts, голос alloy
      const ttsModel = tts_model || "gpt-4o-mini-tts";
      const ttsVoice = tts_voice || "alloy";

      try {
        const speech = await client.audio.speech.create({
          model: ttsModel,
          voice: ttsVoice,
          input: answerText
        });

        // SDK возвращает Readable/Response — получаем base64
        const arrayBuf = await speech.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        audioBase64 = buf.toString("base64");
      } catch (e) {
        // Не роняем весь ответ, если TTS не прошёл
        console.error("TTS error:", e?.message || e);
        audioBase64 = null;
      }
    }

    // Формат ответа оставляем прежним для совместимости с плагином чата
    res.json({
      ok: true,
      text: answerText,
      response: answerText,
      answer: answerText,
      audio: audioBase64, // либо null, если озвучка не запрошена/ошибка
    });
  } catch (err) {
    console.error("Ошибка в /chat:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Внутренняя ошибка сервера.",
    });
  }
});

// --- /blog: длинные статьи для WP-плагина (СТРОГИЙ JSON) --------------------
app.post("/blog", async (req, res) => {
  try {
    const topic = String(req.body?.topic || req.body?.title || "").slice(0, 300);
    const tone = String(req.body?.tone || "профессионально, дружелюбно").slice(0, 120);
    const minWords = Math.max(Number(req.body?.min_words || 900), 600); // минимум 600

    if (!topic) {
      return res.status(400).json({ ok: false, error: "topic required" });
    }

    const blogModel = process.env.MODEL_BLOG || "gpt-4o";
    const apiKeyForBlog = process.env.OPENAI_API_KEY_BLOG || process.env.OPENAI_API_KEY;

    if (!apiKeyForBlog) {
      return res.status(500).json({
        ok: false,
        error: "OPENAI_API_KEY (или OPENAI_API_KEY_BLOG) отсутствует"
      });
    }

    // Отдельный клиент под блог, чтобы можно было использовать другой ключ/модель
    const blogClient = new OpenAI({ apiKey: apiKeyForBlog });

    const systemPrompt = `
Ты — редактор и копирайтер блога "Дед Елисей".
Верни СТРОГО один JSON-объект без пояснений и форматирования кода:
{"title":"H1","content":"HTML..."}.

Требования:
- title: краткий H1 без лишних слов.
- content: полноценная статья ${minWords}+ слов на русском с HTML-разметкой (<h2>, <h3>, <p>, <ul><li>, <ol>), без <h1> в тексте.
- Структура: введение, 3–6 смысловых блоков (h2/h3), списки, вывод, чёткие рекомендации.
- Тон: ${tone}.
- Допустимы 1–2 мягких упоминания "Дед Елисей" (без навязчивой рекламы).
- Только HTML-теги внутри "content", без Markdown.
`.trim();

    const userPrompt = `Тема статьи: "${topic}". Верни строго {"title":"...","content":"..."} без лишнего текста.`;

    const completion = await blogClient.chat.completions.create({
      model: blogModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 3000 // запас, чтобы не обрезало статью
    });

    const raw = completion?.choices?.[0]?.message?.content?.trim() || "";

    const jsonString = raw
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    let obj;
    try {
      obj = JSON.parse(jsonString);
    } catch (_) {
      const m = jsonString.match(/\{[\s\S]*\}/);
      if (m) {
        try { obj = JSON.parse(m[0]); } catch {}
      }
    }

    if (!obj?.title || !obj?.content) {
      return res.status(502).json({
        ok: false,
        error: "LLM returned non-JSON or missing fields",
        raw
      });
    }

    // Простая проверка объёма (по словам)
    const wordCount = String(obj.content)
      .replace(/<[^>]*>/g, " ")
      .split(/\s+/)
      .filter(Boolean).length;

    if (wordCount < minWords) {
      // Не ломаем публикацию, но даём подсказку плагину
      return res.status(200).json({
        ok: true,
        title: obj.title,
        content: obj.content,
        note: `short:${wordCount}`
      });
    }

    res.json({ ok: true, title: obj.title, content: obj.content });
  } catch (err) {
    console.error("Ошибка в /blog:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Внутренняя ошибка сервера"
    });
  }
});

// --- Запуск сервера ----------------------------------------------------------
app.listen(PORT, () => {
  console.log(`GPT proxy listening on port ${PORT}`);
});

export default app;
