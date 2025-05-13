const express = require("express");
const cors = require("cors");
const { Configuration, OpenAIApi } = require("openai");

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    const completion = await openai.createChatCompletion({
      model: "gpt-3.5-turbo", // можешь заменить на "gpt-4", если нужен
      messages,
    });

    res.json(completion.data);
  } catch (error) {
    console.error("Ошибка на сервере:", error.message);
    res.status(500).json({ error: "Ошибка при обращении к OpenAI" });
  }
});

app.listen(port, () => {
  console.log(`Прокси-сервер запущен на порту ${port}`);
});
