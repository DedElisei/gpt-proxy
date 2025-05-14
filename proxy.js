import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
const port = process.env.PORT || 10000;
const apiKey = process.env.OPENAI_API_KEY;

app.use(cors());
app.use(bodyParser.json());

app.post("/chat", async (req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
       model: "gpt-3.5-turbo",
        messages: req.body.messages
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("Ошибка прокси:", error);
    res.status(500).json({ error: "Ошибка при подключении к OpenAI" });
  }
});

app.listen(port, () => {
  console.log(`Прокси-сервер запущен на порту ${port}`);
});
