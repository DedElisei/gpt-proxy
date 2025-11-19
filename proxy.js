// proxy.js — GPT-прокси с поддержкой Assistants API и старого Chat Completions

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 10000;

// --- Клиент OpenAI -----------------------------------------------------------

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Ассистент по умолчанию (можно задать в Render: OPENAI_ASSISTANT_ID=asst_...)
const DEFAULT_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || null;

// --- Middleware --------------------------------------------------------------

app.use(cors());
app.use(express.json());

// --- Health-check -----------------------------------------------------------

app.get("/", (req, res) => {
  res.send("OK: GPT proxy is alive");
});

// --- Главный эндпоинт для чата ----------------------------------------------

app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const {
      model = "gpt-4o",
      messages = [],
      assistantId, // плагин может передать сюда asst_...
    } = body;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Отсутствует OPENAI_API_KEY на сервере.",
      });
    }

    // --------------------------------------------------------------------
    // Выбираем ID ассистента:
    // - из запроса,
    // - или из переменной окружения,
    // НО если там "asst_TEST" — считаем, что ассистента нет и
    // работаем в обычном режиме Chat Completions.
    // --------------------------------------------------------------------
    const rawAssistantId = assistantId || DEFAULT_ASSISTANT_ID;
    const effectiveAssistantId =
      rawAssistantId && rawAssistantId !== "asst_TEST" ? rawAssistantId : null;

    let answerText = "";

    // ===== 1. РЕЖИМ ASSISTANTS, если есть настоящий ID ассистента ==========
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

// --- Запуск сервера ---------------------------------------------------------

app.listen(PORT, () => {
  console.log(`GPT proxy listening on port ${PORT}`);
});

export default app;
