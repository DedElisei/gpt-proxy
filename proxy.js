// proxy.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";

/* =========================
   БАЗОВЫЕ НАСТРОЙКИ
   ========================= */

const PORT = process.env.PORT || 10000;

// Дефолтные модели — можно переопределять переменными среды
// Пример в Render: MODEL_CHAT=gpt-4o-2024-11-20, MODEL_AVATAR=gpt-4o-2024-11-20
const MODEL_CHAT   = process.env.MODEL_CHAT   || "gpt-4o-2024-11-20";
const MODEL_AVATAR = process.env.MODEL_AVATAR || "gpt-4o-2024-11-20";

// Ключи: либо раздельные, либо общий OPENAI_API_KEY
const OPENAI_API_KEY_CHAT =
  process.env.OPENAI_API_KEY_CHAT || process.env.OPENAI_API_KEY || "";
const OPENAI_API_KEY_AVATAR =
  process.env.OPENAI_API_KEY_AVATAR || process.env.OPENAI_API_KEY || "";

/* =========================
   ХЕЛПЕРЫ
   ========================= */

// Вызов старого Chat Completions API
async function callOpenAIChatCompletions({ apiKey, model, messages }) {
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

// Собираем messages из запроса
function buildMessages(req, systemPrompt = "") {
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

  if (incomingMessages && incomingMessages.length > 0) {
    const msgs = [];
    if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
    for (const m of incomingMessages) {
      if (m?.role && m?.content) msgs.push(m);
    }
    return msgs;
  }

  const msgs = [];
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
  if (text) msgs.push({ role: "user", content: text });
  return msgs;
}

/* =========================
   СЕРВЕР
   ========================= */

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// Health
app.get("/", (req, res) => {
  res.send("GPT proxy is running");
});

/* -------------------------------------------------
   1) Универсальные удобные маршруты /chat и /avatar
   ------------------------------------------------- */

app.post("/chat", async (req, res) => {
  try {
    if (!OPENAI_API_KEY_CHAT) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY (CHAT)" });
    }
    const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT_CHAT || "";
    const messages = buildMessages(req, SYSTEM_PROMPT);
    if (messages.length === 0) {
      return res.status(400).json({ error: "Empty input" });
    }

    const answer = await callOpenAIChatCompletions({
      apiKey: OPENAI_API_KEY_CHAT,
      model: MODEL_CHAT,
      messages,
    });

    res.json({ ok: true, text: answer, response: answer, answer });
  } catch (err) {
    console.error("CHAT error:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post("/avatar", async (req, res) => {
  try {
    if (!OPENAI_API_KEY_AVATAR) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY (AVATAR)" });
    }
    const SYSTEM_PROMPT =
      process.env.SYSTEM_PROMPT_AVATAR ||
      "Ты дружелюбный и краткий AI-ассистент. Отвечай живо и ёмко, без лишних прелюдий.";

    const messages = buildMessages(req, SYSTEM_PROMPT);
    if (messages.length === 0) {
      return res.status(400).json({ error: "Empty input" });
    }

    const answer = await callOpenAIChatCompletions({
      apiKey: OPENAI_API_KEY_AVATAR,
      model: MODEL_AVATAR,
      messages,
    });

    res.json({ ok: true, text: answer, response: answer, answer });
  } catch (err) {
    console.error("AVATAR error:", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/* -------------------------------------------------
   2) Прозрачные реле для нового и старого путей OpenAI
   ------------------------------------------------- */

// Новый API: /v1/responses  (его сейчас вызывает ваш WordPress-сниппет)
app.post("/v1/responses", async (req, res) => {
  try {
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const text = await upstream.text();
    res.status(upstream.status).type("application/json").send(text);
  } catch (e) {
    console.error("PROXY /v1/responses error:", e);
    res.status(500).json({ code: "proxy_failed", message: e.message || String(e) });
  }
});

// Старый путь: /v1/chat/completions  (на всякий случай)
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const text = await upstream.text();
    res.status(upstream.status).type("application/json").send(text);
  } catch (e) {
    console.error("PROXY /v1/chat/completions error:", e);
    res.status(500).json({ code: "proxy_failed", message: e.message || String(e) });
  }
});

/* =========================
   START
   ========================= */

app.listen(PORT, () => {
  console.log(`Proxy server is running on port ${PORT}`);
});
