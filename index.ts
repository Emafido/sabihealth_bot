import express, { type Request, type Response } from "express";
import dotenv from "dotenv";
import { handleIncomingQuestion } from "./pipeline-test";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.warn("⚠️  Warning: TELEGRAM_BOT_TOKEN is not set in .env. The bot cannot send replies without it.");
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendTelegramMessage(chatId: number | string, text: string) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`❌ Telegram sendMessage failed (${res.status}):`, errText);
  }
}

app.use(express.json());

app.get("/", (_req: Request, res: Response) => {
  res.status(200).send("🌿 SabiHealth Telegram Bot webhook server is running!");
});

// Telegram webhook route
app.post("/webhook", (req: Request, res: Response) => {
  // Acknowledge immediately so Telegram doesn't retry/timeout
  res.sendStatus(200);

  const message = req.body?.message;
  const chatId = message?.chat?.id;
  const text = (message?.text || "").trim();

  console.log(`\n📥 Incoming Telegram message:`);
  console.log(`   Chat ID: ${chatId}`);
  console.log(`   Text: "${text}"`);

  if (!chatId || !text) {
    console.warn("⚠️  Received update with no chat id or text. Ignoring (may be a non-text update).");
    return;
  }

  (async () => {
    try {
      console.log(`⏳ Processing query for chat ${chatId}...`);
      const reply = await handleIncomingQuestion(String(chatId), text);
      await sendTelegramMessage(chatId, reply);
      console.log(`📤 Reply sent to chat ${chatId}`);
    } catch (error) {
      console.error(`❌ Error in pipeline processing for chat ${chatId}:`, error);
      try {
        await sendTelegramMessage(
          chatId,
          "Sorry, I ran into an issue while processing your question. Please try again shortly or speak with a qualified health worker."
        );
      } catch (fallbackError) {
        console.error(`❌ Failed to send fallback message to chat ${chatId}:`, fallbackError);
      }
    }
  })();
});

app.listen(PORT, () => {
  console.log(`🚀 SabiHealth Telegram webhook server listening on port ${PORT}`);
  console.log(`👉 Webhook URL target: POST http://localhost:${PORT}/webhook`);
});