// proxy.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";

// ---------- конфиг по умолчанию (можно переопределить переменными среды) ----------
const PORT = process.env.PORT || 10000;

// Модели можно переопределить через переменные среды MODEL_CHAT / MODEL_AVATAR
const MODEL_CHAT   = process.env.MODEL_CHAT   || "gpt-3.5-turbo";
const MODEL_AVATAR = process.env.MODEL_AVATAR || "gpt-3.5-turbo";

// Достаём ключи: специализированные и общий
const OPENAI_API_KEY_CHAT   =
  process.env.OPENAI_API_KEY_CHAT || process.env.OPENAI_API_KEY || "";
const OPENAI_API_KEY_AVATAR =
  process.env.OPENAI_API_KEY_AVATAR || process.env.OPENAI_API_KEY || "";

// Общая функция вызова Chat Completions
async function callOpenAI({ apiKey, model, messages }) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.7,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI API error: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  const answer =
    data?.choices?.[0]?.message?.content?.trim() ||
    data?.choices?.[0]?.text?.trim() ||
    "";

  return answer;
}

// Подготовка сообщений из разных форматов входа
function buildMessages(req, systemPrompt = "") {
  // Поддерживаем разные названия полей
  const text =
    req.body?.text ??
    req.body?.message ??
    req.body?.query ??
    req.query?.text ??
    req.query?.message ??
    req.query?.query ??
    "";

  const incomingMessages = Array.isArray(req.body?.messages)
    ? req.body.messages
    : null;

  // Если прислали уже готовый массив messages — используем как есть
  if (incomingMessages && incomingMessages.length > 0) {
    // На всякий случай, подставим system в начало
    const msgs = [];
    if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
    for (const m of incomingMessages) {
      if (m?.role && m?.content) msgs.push(m);
    }
    return msgs;
  }

  // Иначе соберём простейший контекст system+user
  const msgs = [];
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
  if (text) msgs.push({ role: "user", content: text });
  return msgs;
}

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Простейшая проверка
app.get("/", (req, res) => {
  res.send("GPT proxy is running");
});

// ---------- Маршрут для обычного чата ----------
app.post("/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY_CHAT) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY (CHAT)" });
    }

    // При желании можно задать системный промпт для чата:
    const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT_CHAT || "";

    const messages = buildMessages(req, SYSTEM_PROMPT);
    if (messages.length === 0) {
      return res.status(400).json({ error: "Empty input" });
    }

    const answer = await callOpenAI({
      apiKey: OPENAI_API_KEY_CHAT,
      model: MODEL_CHAT,
      messages,
    });

    // Универсальный ответ — разные ключи на выбор
    res.json({
      ok: true,
      text: answer,
      response: answer,
      answer,
    });
  } catch (err) {
    console.error("CHAT error:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ---------- Маршрут для «говорящей головы» ----------
app.post("/avatar", async (req, res) => {
  try {
    if (!OPENAI_API_KEY_AVATAR) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY (AVATAR)" });
    }

    // Системный промпт для аватара (можно настроить в Render)
    const SYSTEM_PROMPT =
      process.env.SYSTEM_PROMPT_AVATAR ||
      "Ты дружелюбный и краткий AI-ассистент. Отвечай живо и ёмко, без лишних прелюдий.";

    const messages = buildMessages(req, SYSTEM_PROMPT);
    if (messages.length === 0) {
      return res.status(400).json({ error: "Empty input" });
    }

    const answer = await callOpenAI({
      apiKey: OPENAI_API_KEY_AVATAR,
      model: MODEL_AVATAR,
      messages,
    });

    // Возвращаем в нескольких полях — чтобы в HeyGen можно было выбрать любое
    res.json({
      ok: true,
      text: answer,       // чаще всего HeyGen удобно читать это поле
      response: answer,   // альтернативные ключи на выбор
      answer,
    });
  } catch (err) {
    console.error("AVATAR error:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server is running on port ${PORT}`);
});
