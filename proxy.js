// proxy.js — обновлённый GPT-прокси с поддержкой Assistants API

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

// Клиент OpenAI, ключ берём из переменных окружения Render
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json());

// Проверка, что сервер жив
app.get("/", (req, res) => {
  res.send("OK: GPT proxy is alive");
});

// Главный эндпоинт, к которому стучится плагин / фронтенд
app.post("/chat", async (req, res) => {
  try {
    const body = req.body || {};
    const {
      model = "gpt-4o",
      messages = [],
      assistantId, // сюда плагин будет передавать asst_...
    } = body;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "Отсутствует OPENAI_API_KEY на сервере.",
      });
    }

    let answerText = "";

    // ===== 1. РЕЖИМ ASSISTANTS, если передан assistantId =====
    if (assistantId) {
      // Берём последнее пользовательское сообщение из массива messages
      const allMessages = Array.isArray(messages) ? messages : [];
      const lastUser = [...allMessages].reverse().find(m => m.role === "user");
      const userContent =
        (lastUser && typeof lastUser.content === "string"
          ? lastUser.content
          : "") || "";

      if (!userContent.trim()) {
        throw new Error("Нет пользовательского текста для ассистента.");
      }

      // 1) Создаём новый thread
      const thread = await client.beta.threads.create();

      // 2) Добавляем в него сообщение пользователя
      await client.beta.threads.messages.create(thread.id, {
        role: "user",
        content: userContent,
      });

      // 3) Запускаем run для указанного ассистента
      let run = await client.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
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
      // ===== 2. СТАРЫЙ РЕЖИМ: Chat Completions, если assistantId не передан =====
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

    // Формат ответа оставляем прежним, чтобы плагин и старый код работали как раньше
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

// Запуск сервера
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`GPT proxy listening on port ${PORT}`);
});
