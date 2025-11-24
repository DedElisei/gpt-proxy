// proxy.js — общий GPT-прокси для нескольких плагинов WordPress
// Поддерживает:
//   - /chat  — диалоги (Assistants API или Chat Completions)
//   - /blog  — генерация статей (отдельный ассистент/ключ, если нужно)

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------------------------------------------------------------------
// БАЗОВАЯ НАСТРОЙКА
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Выбор API-ключа по типу запроса
function getApiKey(kind) {
  if (kind === "chat") {
    return process.env.OPENAI_API_KEY_CHAT || process.env.OPENAI_API_KEY;
  }
  if (kind === "blog") {
    return process.env.OPENAI_API_KEY_BLOG || process.env.OPENAI_API_KEY;
  }
  // запасной вариант
  return process.env.OPENAI_API_KEY;
}

// Кэшируем клиентов, чтобы не создавать их каждый раз
const clients = {};

function getClient(kind) {
  const key = getApiKey(kind);
  if (!key) {
    throw new Error(
      `Не задан ключ OpenAI для режима "${kind}". Проверь переменные среды.`
    );
  }

  if (!clients[kind] || clients[kind].apiKey !== key) {
    clients[kind] = new OpenAI({ apiKey: key });
  }

  return clients[kind];
}

// Достаём текст из messages Assistants API
function extractAssistantText(messagesList) {
  if (!messagesList || !messagesList.data || messagesList.data.length === 0) {
    return "";
  }
  const msg = messagesList.data[0]; // последний (order: "desc")
  if (!msg.content || !Array.isArray(msg.content)) return "";
  return msg.content
    .map((c) => (c.type === "text" && c.text && c.text.value) || "")
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// /chat — РАБОТА ДЛЯ ПЛАГИНА ДИАЛОГОВ
// ---------------------------------------------------------------------------
//
// Ожидаемый формат тела (мы сделали его максимально гибким):
// {
//   message: "Текст последнего вопроса пользователя"  // ИЛИ
//   prompt:  "То же самое"                           // ИЛИ
//   messages: [ {role:"user", content:"..."}, ... ], // при наличии истории
//   history:  [ {role:"user", content:"..."}, ... ],
//   model:    "gpt-4o-mini" (необязательно),
//   assistant_id: "asst_..." (необязательно)
// }
//
// Ответ:
// { ok: true, content: "готовый текст ответа", raw: {...} }
// Плагин обычно использует только поле content.

app.post("/chat", async (req, res) => {
  try {
    const client = getClient("chat");

    const {
      messages,
      history,
      message,
      prompt,
      model,
      assistant_id: assistantIdFromBody,
    } = req.body || {};

    // Собираем массив messages в стиле Chat API
    let chatMessages = [];

    if (Array.isArray(messages) && messages.length > 0) {
      chatMessages = messages;
    } else {
      if (Array.isArray(history) && history.length > 0) {
        chatMessages = [...history];
      }
      const lastUserMessage = message || prompt;
      if (lastUserMessage) {
        chatMessages.push({ role: "user", content: lastUserMessage });
      }
    }

    if (!chatMessages.length) {
      return res.status(400).json({
        ok: false,
        error: "Пустой запрос: не найдено поле message/prompt/messages/history.",
      });
    }

    const assistantId =
      assistantIdFromBody ||
      process.env.OPENAI_ASSISTANT_ID_CHAT ||
      process.env.OPENAI_ASSISTANT_ID ||
      null;

    // Если задан ассистент — используем Assistants API
    if (assistantId) {
      const thread = await client.beta.threads.create({
        messages: chatMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      const run = await client.beta.threads.runs.createAndPoll(thread.id, {
        assistant_id: assistantId,
      });

      if (run.status !== "completed") {
        throw new Error(
          `Ассистент завершился со статусом: ${run.status || "unknown"}`
        );
      }

      const messagesList = await client.beta.threads.messages.list(thread.id, {
        order: "desc",
        limit: 1,
      });

      const content = extractAssistantText(messagesList);

      return res.json({
        ok: true,
        content,
        mode: "assistant",
        thread_id: thread.id,
        run_id: run.id,
      });
    }

    // Иначе — классический Chat Completions
    const usedModel = model || "gpt-4o-mini";

    const completion = await client.chat.completions.create({
      model: usedModel,
      messages: chatMessages,
    });

    const content =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Извините, не удалось получить ответ от модели.";

    return res.json({
      ok: true,
      content,
      mode: "chat",
      raw: completion,
    });
  } catch (err) {
    console.error("Ошибка в /chat:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Внутренняя ошибка сервера.",
    });
  }
});

// ---------------------------------------------------------------------------
// /blog — ДЛЯ ПЛАГИНА ГЕНЕРАЦИИ СТАТЕЙ
// ---------------------------------------------------------------------------
//
// Твой WP-плагин генерации статей сейчас отправляет примерно такое тело:
// {
//   model:  "gpt-4o-mini",
//   prompt: "текст промпта",
//   api_key: ""   // игнорируем, ключ берём из окружения
// }
//
// Мы добавляем поддержку собственного ассистента:
//   OPENAI_ASSISTANT_ID_BLOG = asst_... (инструкция + знания для статей)
//
// Если ассистент задан — используем Assistants API, иначе обычный Chat.

app.post("/blog", async (req, res) => {
  try {
    const client = getClient("blog");

    const { prompt, topic, model } = req.body || {};

    const userPrompt = prompt || topic;
    if (!userPrompt) {
      return res.status(400).json({
        ok: false,
        error: "Пустой запрос: не найдено поле prompt или topic.",
      });
    }

    const assistantId =
      process.env.OPENAI_ASSISTANT_ID_BLOG ||
      process.env.OPENAI_ASSISTANT_ID ||
      null;

    // Вариант 1. Есть ассистент для блога — работаем через Assistants API
    if (assistantId) {
      const thread = await client.beta.threads.create({
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      });

      const run = await client.beta.threads.runs.createAndPoll(thread.id, {
        assistant_id: assistantId,
      });

      if (run.status !== "completed") {
        throw new Error(
          `Ассистент (blog) завершился со статусом: ${run.status || "unknown"}`
        );
      }

      const messagesList = await client.beta.threads.messages.list(thread.id, {
        order: "desc",
        limit: 1,
      });

      const content = extractAssistantText(messagesList);

      return res.json({
        ok: true,
        content,
        mode: "assistant-blog",
        thread_id: thread.id,
        run_id: run.id,
      });
    }

    // Вариант 2. Ассистента нет — обычный Chat Completions.
    const usedModel = model || "gpt-4o-mini";

    const completion = await client.chat.completions.create({
      model: usedModel,
      messages: [
        {
          role: "system",
          content:
            "Ты — генератор SEO-статей для сайта. Пиши структурированные статьи с подзаголовками h2/h3, списками и выводом.",
        },
        { role: "user", content: userPrompt },
      ],
    });

    const content =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Извините, не удалось сгенерировать статью.";

    return res.json({
      ok: true,
      content,
      mode: "chat-blog",
      raw: completion,
    });
  } catch (err) {
    console.error("Ошибка в /blog:", err);
    res.status(500).json({
      ok: false,
      error: err.message || "Внутренняя ошибка сервера.",
    });
  }
});

// ---------------------------------------------------------------------------
// СЛУЖЕБНЫЕ МАРШРУТЫ И ЗАПУСК
// ---------------------------------------------------------------------------

// Простой ping, чтобы проверить, что сервер жив
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "GPT-proxy работает. Маршруты: /chat, /blog",
  });
});

app.listen(PORT, () => {
  console.log(`GPT proxy listening on port ${PORT}`);
});

export default app;
