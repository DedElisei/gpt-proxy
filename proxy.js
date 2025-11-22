// proxy.js — GPT-прокси с поддержкой Assistants API, чата и генератора статей

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 10000;

// --- Middleware --------------------------------------------------------------

app.use(cors());
app.use(express.json());

// --- Health-check -----------------------------------------------------------

app.get("/", (req, res) => {
  res.send("OK: GPT proxy is alive");
});

// ============================================================================
//  /chat — ДЛЯ Ded AI Chat (Assistants + Voice)
//  Поведение сохранено: Assistants + старый Chat Completions, формат ответа
//  { ok, text, response, answer }
// ============================================================================

app.post("/chat", async (req, res) => {
  try {
    const apiKey =
      process.env.OPENAI_API_KEY_CHAT || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error:
          "Отсутствует OPENAI_API_KEY_CHAT и OPENAI_API_KEY на сервере.",
      });
    }

    const client = new OpenAI({ apiKey });

    const body = req.body || {};
    const {
      model = "gpt-4o",
      messages = [],
      assistantId, // плагин может передать сюда asst_...
    } = body;

    // --------------------------------------------------------------------
    // Выбираем ID ассистента:
    // - из запроса,
    // - или из переменной окружения OPENAI_ASSISTANT_ID.
    // Если значение "asst_TEST" — считаем, что ассистента нет
    // и работаем в обычном режиме Chat Completions.
    // --------------------------------------------------------------------
    const rawAssistantId =
      assistantId || process.env.OPENAI_ASSISTANT_ID || null;
    const effectiveAssistantId =
      rawAssistantId && rawAssistantId !== "asst_TEST" ? rawAssistantId : null;

    let answerText = "";

    // ===== 1. РЕЖИМ ASSISTANTS, если есть настоящий ID ассистента ==========
    if (effectiveAssistantId) {
      const allMessages = Array.isArray(messages) ? messages : [];

      // Берём последнее user-сообщение
      const lastUser = [...allMessages].reverse().find((m) => m.role === "user");
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
        await new Promise((r) => setTimeout(r, 1000));
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
        (m) => m.role === "assistant"
      );

      if (!assistantMessages.length) {
        throw new Error("Ассистент не вернул сообщений.");
      }

      const m = assistantMessages[0]; // самое свежее
      const textParts = (m.content || [])
        .filter((part) => part.type === "text")
        .map((part) => part.text.value);

      answerText = textParts.join("\n").trim();
    } else {
      // ===== 2. СТАРЫЙ РЕЖИМ: Chat Completions ==============================
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

    // Формат ответа оставляем прежним для совместимости
    res.json({
      ok: true,
      text: answerText,
      response: answerText,
      answer: answerText,
    });
  } catch (err) {
    console.error("Ошибка в /chat:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Внутренняя ошибка сервера.",
    });
  }
});

// ============================================================================
//  /blog — ДЛЯ AI Content Generator (Ded Elisei)
//  Принимает { model, prompt, api_key? } и возвращает { content: "статья..." }.
//  Плагин на WordPress менять не нужно — он ждёт именно такое поле "content".
// ============================================================================

app.post("/blog", async (req, res) => {
  try {
    const apiKey =
      process.env.OPENAI_API_KEY_BLOG || process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error:
          "Отсутствует OPENAI_API_KEY_BLOG и OPENAI_API_KEY на сервере.",
      });
    }

    const client = new OpenAI({ apiKey });

    const body = req.body || {};
    const {
      model = "gpt-4o-mini",
      prompt = "",
      temperature = 0.7,
      max_tokens = 4096,
    } = body;

    if (!prompt || !prompt.trim()) {
      return res
        .status(400)
        .json({ error: "Пустой prompt для генерации статьи." });
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

    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature,
      max_tokens,
    });

    const content =
      completion.choices?.[0]?.message?.content?.trim() || "";

    if (!content) {
      return res
        .status(500)
        .json({ error: "Пустой ответ от OpenAI при генерации статьи." });
    }

    // Возвращаем в формате, который ждёт WP-плагин: поле "content"
    res.json({ content });
  } catch (err) {
    console.error("Ошибка в /blog:", err);
    res.status(500).json({
      error: err.message || "Внутренняя ошибка сервера /blog.",
    });
  }
});

// --- Запуск сервера ---------------------------------------------------------

app.listen(PORT, () => {
  console.log(`GPT proxy listening on port ${PORT}`);
});

export default app;
