// proxy.js — GPT-прокси для Деда Елисея
//
// Маршруты:
//   /chat   — живой ИИ-ассистент на сайте (Ded AI Chat + Voice). ФОРМАТ ОТВЕТА МЕНЯТЬ НЕЛЬЗЯ.
//   /blog   — генерация статей для WordPress-плагина AI Content Generator.
//   /school — Учитель AI-школы Деда Елисея (отдельный плагин Ded AI School Chat).
//
// Переменные окружения (Environment на Render):
//   OPENAI_API_KEY        — ОБЯЗАТЕЛЬНО, общий ключ (для /chat и /school).
//   OPENAI_ASSISTANT_ID   — (опционально) ассистент по умолчанию для /chat.
//   OPENAI_API_KEY_BLOG   — (опционально) отдельный ключ только для /blog.
//   MODEL_BLOG            — (опционально) модель для /blog, напр. "gpt-4o-mini".

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------------------------------------------------------------------
// Клиент OpenAI для /chat и /school (главные ассистенты)
// ---------------------------------------------------------------------------

if (!process.env.OPENAI_API_KEY) {
  console.error("ВНИМАНИЕ: OPENAI_API_KEY не задан. Прокси работать не будет.");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Ассистент по умолчанию только для /chat (если не передали явный assistantId)
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
// /chat — главный рабочий эндпоинт для ЖИВОГО чата (старый плагин)
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

    // ---------- Попытка 1: Assistants API ----------
    if (effectiveAssistantId) {
      try {
        const allMessages = Array.isArray(messages) ? messages : [];

        // Берём последнее user-сообщение
        const lastUser = [...allMessages].reverse().find((m) => m.role === "user");
        let userContent = "";

        if (lastUser) {
          const c = lastUser.content;
          if (typeof c === "string") {
            userContent = c;
          } else if (Array.isArray(c)) {
            userContent = c
              .map((part) => {
                if (typeof part === "string") return part;
                if (part && typeof part.text === "string") return part.text;
                if (part && typeof part.value === "string") return part.value;
                if (
                  part &&
                  part.type === "input_text" &&
                  typeof part.text === "string"
                ) {
                  return part.text;
                }
                return "";
              })
              .filter(Boolean)
              .join("\n");
          } else if (c && typeof c === "object" && typeof c.text === "string") {
            userContent = c.text;
          }
        }

        userContent = (userContent || "").trim();
        if (!userContent) {
          throw new Error("Нет текстового содержимого в последнем сообщении пользователя.");
        }

        const thread = await client.beta.threads.create();

        await client.beta.threads.messages.create(thread.id, {
          role: "user",
          content: userContent,
        });

        let run = await client.beta.threads.runs.create(thread.id, {
          assistant_id: effectiveAssistantId,
        });

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

        const msgList = await client.beta.threads.messages.list(thread.id, {
          limit: 10,
        });

        const assistantMessages = msgList.data.filter(
          (m) => m.role === "assistant"
        );
        if (!assistantMessages.length) {
          throw new Error("Ассистент не вернул сообщений.");
        }

        const m = assistantMessages[0];
        const textParts = (m.content || [])
          .filter((part) => part.type === "text")
          .map((part) => part.text.value);

        answerText = textParts.join("\n").trim();
      } catch (e) {
        console.error("Ошибка Assistants API в /chat, выполняем fallback:", e);
        answerText = "";
      }
    }

    // ---------- Попытка 2: Chat Completions (fallback или основной путь) ----------
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

    // ---------- TTS (по желанию) ----------
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

    // Структура ответа — как и раньше, чтобы плагин чата не сломался
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
// /school — Учитель AI-школы Деда Елисея (новый маршрут)
// Тут мы поддерживаем несколько вариантов тела запроса,
// чтобы не зависеть от версии плагина.
// ВАЖНО: теперь в Assistants API передаётся ВЕСЬ диалог, а не только
// последнее сообщение пользователя.
// ---------------------------------------------------------------------------

app.post("/school", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "На сервере не задан OPENAI_API_KEY",
      });
    }

    const body = req.body || {};

    // Модель и голосовые настройки (на будущее)
    const {
      model = "gpt-4o",
      voice = false,
      tts_model,
      tts_voice,
    } = body;

    // Ассистент: поддерживаем и assistantId, и assistant_id
    const rawAssistantId = body.assistantId || body.assistant_id || null;
    const effectiveAssistantId =
      rawAssistantId && rawAssistantId !== "asst_TEST" ? rawAssistantId : null;

    // Собираем messages из разных возможных полей
    let messages = [];

    if (Array.isArray(body.messages) && body.messages.length > 0) {
      messages = body.messages;
    } else if (Array.isArray(body.history) && body.history.length > 0) {
      messages = body.history;
    } else if (typeof body.message === "string" && body.message.trim()) {
      messages = [
        {
          role: "user",
          content: body.message.trim(),
        },
      ];
    }

    if (!messages || messages.length === 0) {
      return res.status(400).json({
        ok: false,
        error:
          "В /school не переданы данные для диалога (нет messages/history/message).",
      });
    }

    let answerText = "";

    // Небольшой помощник: вытаскиваем текст из content в разных форматах
    const extractTextFromContent = (c) => {
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part.text === "string") return part.text;
            if (part && typeof part.value === "string") return part.value;
            if (
              part &&
              part.type === "input_text" &&
              typeof part.text === "string"
            ) {
              return part.text;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      if (c && typeof c === "object" && typeof c.text === "string") {
        return c.text;
      }
      return "";
    };

    // ---------- Попытка 1: Assistants API (если есть ассистент) ----------
    if (effectiveAssistantId) {
      try {
        const allMessages = Array.isArray(messages) ? messages : [];
        const thread = await client.beta.threads.create();

        // Добавляем ВЕСЬ диалог (user + assistant) в новый thread
        let hasUserMessage = false;

        for (const msg of allMessages) {
          const role = msg.role === "assistant" ? "assistant" : "user"; // system игнорируем
          const text = extractTextFromContent(msg.content);
          const trimmed = (text || "").trim();
          if (!trimmed) continue;

          if (role === "user") {
            hasUserMessage = true;
          }

          await client.beta.threads.messages.create(thread.id, {
            role,
            content: trimmed,
          });
        }

        if (!hasUserMessage) {
          throw new Error("В истории /school нет ни одного сообщения пользователя.");
        }

        let run = await client.beta.threads.runs.create(thread.id, {
          assistant_id: effectiveAssistantId,
        });

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

        const msgList = await client.beta.threads.messages.list(thread.id, {
          limit: 10,
        });

        const assistantMessages = msgList.data.filter(
          (m) => m.role === "assistant"
        );
        if (!assistantMessages.length) {
          throw new Error("Ассистент не вернул сообщений.");
        }

        const m = assistantMessages[0];
        const textParts = (m.content || [])
          .filter((part) => part.type === "text")
          .map((part) => part.text.value);

        answerText = textParts.join("\n").trim();
      } catch (e) {
        console.error("Ошибка Assistants API в /school, выполняем fallback:", e);
        answerText = "";
      }
    }

    // ---------- Попытка 2: Chat Completions (если нет ассистента или ошибка) ----------
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

    // ---------- TTS (по желанию) ----------
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
        console.error("TTS error (/school):", e?.message || e);
        audioBase64 = null;
      }
    }

    res.json({
      ok: true,
      text: answerText,
      response: answerText,
      answer: answerText,
      audio: audioBase64,
    });
  } catch (err) {
    console.error("Ошибка в /school:", err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Внутренняя ошибка сервера в /school",
    });
  }
});

// ---------------------------------------------------------------------------
// /blog — эндпоинт для генерации статей (WordPress-плагин AI Content Generator)
// ТЕПЕРЬ: если в поле model передан asst_..., используется Assistants API.
// Иначе — как раньше, обычный chat.completions.
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

    // modelRaw — то, что пришло из плагина или из ENV
    const modelRaw =
      (typeof body.model === "string" && body.model.trim()) ||
      process.env.MODEL_BLOG ||
      "gpt-4o-mini";

    let assistantIdForBlog = null;
    let model = modelRaw;

    // Если model начинается с "asst_" — считаем это ID ассистента
    if (typeof modelRaw === "string" && modelRaw.trim().startsWith("asst_")) {
      assistantIdForBlog = modelRaw.trim();
      // Для fallback через chat.completions используем MODEL_BLOG или дефолт
      model = process.env.MODEL_BLOG || "gpt-4o-mini";
    }

    // 1. messages из тела запроса (как в старом варианте)
    let messages = Array.isArray(body.messages) ? body.messages : null;

    // 2. Если messages нет, пробуем собрать их из prompt
    if (!messages || messages.length === 0) {
      const prompt =
        typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (prompt) {
        messages = [
          {
            role: "user",
            content: prompt,
          },
        ];
      }
    }

    if (!messages || messages.length === 0) {
      return res.status(400).json({
        ok: false,
        error:
          "В /blog не переданы данные для генерации статьи (нет ни messages, ни prompt).",
      });
    }

    // Вспомогательная функция: вытащить текст из content в разных форматах
    const extractTextFromContent = (c) => {
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part.text === "string") return part.text;
            if (part && typeof part.value === "string") return part.value;
            if (
              part &&
              part.type === "input_text" &&
              typeof part.text === "string"
            ) {
              return part.text;
            }
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      if (c && typeof c === "object" && typeof c.text === "string") {
        return c.text;
      }
      return "";
    };

    let content = "";

    // ---------- Попытка 1: Assistants API, если передан asst_... ----------
    if (assistantIdForBlog) {
      try {
        const thread = await blogClient.beta.threads.create();

        // Обычно messages один, но на всякий случай проходим по всем
        for (const msg of messages) {
          const role = msg.role === "assistant" ? "assistant" : "user";
          const text = extractTextFromContent(msg.content);
          const trimmed = (text || "").trim();
          if (!trimmed) continue;

          await blogClient.beta.threads.messages.create(thread.id, {
            role,
            content: trimmed,
          });
        }

        let run = await blogClient.beta.threads.runs.create(thread.id, {
          assistant_id: assistantIdForBlog,
        });

        while (
          run.status === "queued" ||
          run.status === "in_progress" ||
          run.status === "cancelling"
        ) {
          await new Promise((r) => setTimeout(r, 1000));
          run = await blogClient.beta.threads.runs.retrieve(thread.id, run.id);
        }

        if (run.status !== "completed") {
          throw new Error("Ассистент не завершил ответ. Статус: " + run.status);
        }

        const msgList = await blogClient.beta.threads.messages.list(thread.id, {
          limit: 10,
        });

        const assistantMessages = msgList.data.filter(
          (m) => m.role === "assistant"
        );
        if (!assistantMessages.length) {
          throw new Error("Ассистент не вернул сообщений.");
        }

        const m = assistantMessages[0];
        const textParts = (m.content || [])
          .filter((part) => part.type === "text")
          .map((part) => part.text.value);

        content = textParts.join("\n").trim();
      } catch (e) {
        console.error("Ошибка Assistants API в /blog, выполняем fallback:", e);
        content = "";
      }
    }

    // ---------- Попытка 2: обычный Chat Completions (как раньше) ----------
    if (!content) {
      const completion = await blogClient.chat.completions.create({
        model,
        messages,
        temperature:
          typeof body.temperature === "number" ? body.temperature : 0.6,
        max_tokens:
          typeof body.max_tokens === "number" ? body.max_tokens : 3500,
      });

      content =
        completion.choices?.[0]?.message?.content?.trim() || "";
    }

    if (!content) {
      return res.status(500).json({
        ok: false,
        error: "Пустой ответ от OpenAI в /blog",
      });
    }

    // ---------- Удаляем возможный JSON/```json и берём только article ----------
    try {
      let jsonCandidate = content.trim();

      // Если ответ обёрнут в ```json ... ``` — вырезаем обёртку
      if (jsonCandidate.startsWith("```")) {
        const firstNewline = jsonCandidate.indexOf("\n");
        const lastFence = jsonCandidate.lastIndexOf("```");
        if (firstNewline !== -1 && lastFence !== -1 && lastFence > firstNewline) {
          jsonCandidate = jsonCandidate
            .slice(firstNewline + 1, lastFence)
            .trim();
        }
      }

      // Пытаемся распарсить как JSON
      const parsed = JSON.parse(jsonCandidate);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.content === "string" &&
        parsed.content.trim()
      ) {
        content = parsed.content.trim();
      }
      // Если парсинг не удался — просто остаётся исходный content
    } catch (e) {
      // Тихо игнорируем — значит это был обычный текст статьи
    }

    // Отдаём только чистый текст
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
