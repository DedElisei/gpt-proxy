import express from "express";
import cors from "cors";

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

app.post("/v1/chat/completions", async (req, res) => {
  try {
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error("Ошибка на сервере прокси:", error);
    res.status(500).json({ error: "Прокси не смог получить ответ от OpenAI." });
  }
});

app.listen(port, () => {
  console.log(`Прокси-сервер запущен на порту ${port}`);
});
