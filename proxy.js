// proxy.js — GPT-прокси для Деда Елисея

// Маршруты:
//   /chat  — живой ИИ-ассистент на сайте (Ded AI Chat + Voice). ФОРМАТ ОТВЕТА МЕНЯТЬ НЕЛЬЗЯ.
//   /blog  — генерация статей для WordPress-плагина AI Content Generator.
//
// Переменные окружения (Environment на Render):
//   OPENAI_API_KEY        — ОБЯЗАТЕЛЬНО, общий ключ (для /chat).
//   OPENAI_ASSISTANT_ID   — (опционально) ассистент по умолчанию для /chat.
//   OPENAI_API_KEY_BLOG   — (опционально) отдельный ключ только для /blog.
//   MODEL_BLOG            — (опционально) модель для /blog, напр. "gpt-4o-mini".

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------------------------------------------------------------------
// Клиент OpenAI для /chat (главный рабочий ассистент)
// ---------------------------------------------------------------------------

if (!process.env.OPENAI_API_KEY) {
  console.error("ВНИМАНИЕ: OPENAI_API_KEY не задан. Прокси работать не будет.");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Ассистент для /chat по умолчанию (если не передали явный assistantId)
const DEFAULT_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || null;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// Health-check
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.send("OK: GPT proxy is alive");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "gpt-proxy" });
});

// Простой тест для /blog через браузер (GET-запрос)
app.get("/blog", (req, res) => {
  res.send("BLOG endpoint is alive (GET)");
});

// ---------------------------------------------------------------------------
// /chat — главный рабочий эндпоинт для ЖИВОГО чата (другой плагин)
// ВАЖНО: формат ответа сохраняем, чтобы ничего не сломать.
// ---------------------------------------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "На сервере не задан OPENAI_API_KEY",
      });
    }

    const body = req.body || {};
    const {
      model = "gpt-4o",
      messages = [],
      assistantId,   // может прийти asst_... — тогда используем Assistants API
      voice = false, // если true — делаем TTS и возвращаем audio (base64)
      tts_model,     // опционально, например "gpt-4o-mini-tts"
      tts_voice,     // опционально, например "alloy"
    } = body;

    let answerText = "";

    // Выбираем ассистента: либо переданный, либо стандартный из ENV
    const rawAssistantId = assistantId || DEFAULT_ASSISTANT_ID;
    const effectiveAssistantId =
      rawAssistantId && rawAssistantId !== "asst_TEST" ? rawAssistantId : null;

    // -----------------------------------------------------------------------
    // Попытка 1: Assistants API (если задан assistantId)
    // Если что-то пойдёт не так — тихо логируем и ниже делаем fallback
    // на обычный Chat Completions.
    // -----------------------------------------------------------------------

    if (effectiveAssistantId) {
      try {
        const allMessages = Array.isArray(messages) ? messages : [];

        // Берём последнее user-сообщение
        const lastUser = [...allMessages].reverse().find(m => m.role === "user");

        let userContent = "";

        if (lastUser) {
          const c = lastUser.content;

          if (typeof c === "string") {
            // Обычная строка
            userContent = c;
          } else if (Array.isArray(c)) {
            // Массив частей (текст + файлы и т.п.)
            userContent = c
              .map(part => {
                // Возможные варианты структуры
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
                if (part && typeof part.value === "string") return part.value;
                if (part && part.type === "input_text" && typeof part.text === "string") {
                  return part.text;
                }
                return "";
              })
              .filter(Boolean)
              .join("\n");
          } else if (c && typeof c === "object" && typeof c.text === "string") {
            // Объект с полем text
            userContent = c.text;
          }
        }

        userContent = (userContent || "").trim();

        if (!userContent) {
          throw new Error("Нет текстового содержимого в последнем сообщении пользователя.");
        }

        // 1) Создаём thread
        const thread = await client.beta.threads.create();

        // 2) Добавляем сообщение пользователя
        await client.beta.threads.messages.create(thread.id, {
          role: "user",
          content: userContent,
        });

        // 3) Запускаем run
        let run = await client.beta.threads.runs.create(thread.id, {
          assistant_id: effectiveAssistantId,
        });

        // 4) Ждём завершения
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
      } catch (e) {
        console.error("Ошибка Assistants API в /chat, выполняем fallback:", e);
        // Не выбрасываем ошибку дальше — ниже будет обычный Chat Completions
        answerText = "";
      }
    }

    // -------------------------------------------------------------------
    // Попытка 2: обычный Chat Completions (fallback или основной путь)
    // -------------------------------------------------------------------
    if (!answerText) {
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

    // -------------------------------------------------------------------
    // Опциональная озвучка (TTS): возвращаем audio в base64
    // -------------------------------------------------------------------
    let audioBase64 = null;

    if (voice === true) {
      const ttsModel = tts_model || "gpt-4o-mini-tts";
      const ttsVoice = tts_voice || "alloy";

      try {
        const speech = await client.audio.speech.create({
          model: ttsModel,
          voice: ttsVoice,
          input: answerText,
        });

        const arrayBuf = await speech.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        audioBase64 = buf.toString("base64");
      } catch (e) {
        console.error("TTS error:", e?.message || e);
        audioBase64 = null; // Не роняем основной ответ
      }
    }

    // ВАЖНО: структура ответа — как и раньше, чтобы плагин чата не сломался
    res.json({
      ok: true,
      text: answerText,
      response: answerText,
      answer: answerText,
      audio: audioBase64,
    });
  } catch (err) {
    console.error("Ошибка в /chat:", err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Внутренняя ошибка сервера в /chat",
    });
  }
});

// ---------------------------------------------------------------------------
// /blog — эндпоинт для генерации статей (WordPress-плагин AI Content Generator)
//
// Плагин сейчас отправляет: { model, prompt, api_key? }
// Мы:
//   1) Берём model и prompt,
//   2) Делаем messages[],
//   3) Вызываем OpenAI,
//   4) Возвращаем JSON { content: "текст статьи..." }.
// ---------------------------------------------------------------------------

app.post("/blog", async (req, res) => {
  try {
    const body = req.body || {};

    const apiKeyForBlog =
      process.env.OPENAI_API_KEY_BLOG || process.env.OPENAI_API_KEY;

    if (!apiKeyForBlog) {
      return res.status(500).json({
        ok: false,
        error:
          "На сервере не задан ни OPENAI_API_KEY_BLOG, ни OPENAI_API_KEY для /blog",
      });
    }

    const blogClient = new OpenAI({ apiKey: apiKeyForBlog });

    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    const model = body.model || process.env.MODEL_BLOG || "gpt-4o-mini";

    if (!prompt.trim()) {
      return res.status(400).json({
        ok: false,
        error: "В /blog не передан prompt для генерации статьи.",
      });
    }

    const messages = [
      {
        role: "system",
        content:
          "Ты опытный копирайтер и SEO-специалист. Пиши подробные, структурированные статьи для владельцев малого и среднего бизнеса на русском языке. Используй подзаголовки h2/h3, списки и логичные абзацы. Не добавляй теги <html>, <head>, <body> — только содержимое статьи.",
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    const completion = await blogClient.chat.completions.create({
      model,
      messages,
      temperature:
        typeof body.temperature === "number" ? body.temperature : 0.6,
      max_tokens:
        typeof body.max_tokens === "number" ? body.max_tokens : 3500,
    });

    const content =
      completion.choices?.[0]?.message?.content?.trim() || "";

    if (!content) {
      return res.status(500).json({
        ok: false,
        error: "Пустой ответ от OpenAI в /blog",
      });
    }

    // Плагин ожидает JSON с полем "content"
    res.status(200).json({ content });
  } catch (err) {
    console.error("Ошибка в /blog:", err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Внутренняя ошибка сервера в /blog",
    });
  }
});

// ---------------------------------------------------------------------------
// Запуск сервера
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`GPT proxy listening on port ${PORT}`);
});

export default app;
