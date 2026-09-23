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

async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  replyMarkup?: Record<string, unknown>
) {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(`❌ Telegram sendMessage failed (${res.status}):`, errText);
  }
}

interface TelegramFileResponse {
  ok: boolean;
  result?: {
    file_id?: string;
    file_path?: string;
  };
  description?: string;
}

interface GroqTranscriptionResponse {
  text: string;
}

async function transcribeVoice(fileId: string): Promise<string> {
  // 1. Get the file path from Telegram
  const fileInfoRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const fileInfo = (await fileInfoRes.json()) as TelegramFileResponse;
  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${JSON.stringify(fileInfo)}`);
  }
  const filePath = fileInfo.result.file_path;

  // 2. Download the actual audio (.ogg/Opus format)
  const audioUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const audioRes = await fetch(audioUrl);
  const audioBuffer = await audioRes.arrayBuffer();

  // 3. Send to Groq's Whisper endpoint for transcription
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "voice.ogg");
  formData.append("model", "whisper-large-v3-turbo");

  const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
    body: formData,
  });

  if (!groqRes.ok) {
    const errText = await groqRes.text();
    throw new Error(`Groq transcription failed (${groqRes.status}): ${errText}`);
  }

  const result = (await groqRes.json()) as GroqTranscriptionResponse;
  return result.text;
}

interface TelegramLocation {
  latitude: number;
  longitude: number;
}

interface OverpassElement {
  type: string;
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

function calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in kilometers
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function fetchOverpassData(query: string): Promise<OverpassResponse> {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
  ];

  let lastError: unknown = null;

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "SabiHealthBot/1.0 (+https://t.me/sabihealth)",
        },
        body: "data=" + encodeURIComponent(query),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Overpass endpoint ${endpoint} failed with HTTP ${res.status}`);
      }

      const text = await res.text();
      return JSON.parse(text) as OverpassResponse;
    } catch (err) {
      console.warn(`⚠️ Overpass query to ${endpoint} failed, trying next mirror:`, err);
      lastError = err;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("All Overpass endpoints failed.");
}

async function handleNearbyHospitals(chatId: number | string, userLat: number, userLon: number): Promise<void> {
  const query = `[out:json][timeout:15];
(
  node["amenity"="hospital"](around:5000,${userLat},${userLon});
  node["amenity"="clinic"](around:5000,${userLat},${userLon});
);
out body;`;

  const data = await fetchOverpassData(query);

  const elements = data.elements || [];
  const withDistance = elements
    .filter((el) => typeof el.lat === "number" && typeof el.lon === "number")
    .map((el) => ({
      name: el.tags?.name?.trim() || "Unnamed hospital/clinic",
      lat: el.lat,
      lon: el.lon,
      distanceKm: calculateDistanceKm(userLat, userLon, el.lat, el.lon),
    }));

  if (withDistance.length === 0) {
    await sendTelegramMessage(
      chatId,
      "I couldn't find any hospitals nearby in my current data. Please try a nearby town's name, or contact a local health worker for the nearest facility."
    );
    console.log(`📤 Reply sent to chat ${chatId} (no nearby hospitals found)`);
    return;
  }

  withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
  const closest = withDistance.slice(0, 3);

  const itemsText = closest
    .map(
      (item, idx) =>
        `${idx + 1}. ${item.name} — ${item.distanceKm.toFixed(1)}km away\n   https://www.google.com/maps?q=${item.lat},${item.lon}`
    )
    .join("\n\n");

  const reply = `Here are the closest hospitals/clinics I found:\n\n${itemsText}\n\nIf it's urgent, please call emergency services or go to the nearest facility right away.`;

  await sendTelegramMessage(chatId, reply);
  console.log(`📤 Reply sent to chat ${chatId} (found ${closest.length} nearby facilities)`);
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
  const voice = message?.voice;
  const location = message?.location as TelegramLocation | undefined;
  let text = (message?.text || "").trim();

  const hasLocation =
    typeof location?.latitude === "number" && typeof location?.longitude === "number";

  console.log(`\n📥 Incoming Telegram message:`);
  console.log(`   Chat ID: ${chatId}`);
  if (hasLocation) {
    console.log(`   Location: lat=${location!.latitude}, lon=${location!.longitude}`);
  } else if (voice) {
    console.log(`   Voice note received (file_id: ${voice.file_id})`);
  } else {
    console.log(`   Text: "${text}"`);
  }

  if (!chatId || (!text && !voice && !hasLocation)) {
    console.warn("⚠️  Received update with no chat id, text, voice, or location. Ignoring (may be an unsupported update type).");
    return;
  }

  if (text === "/start") {
    const introMessage =
      "🌿 Welcome to SabiHealth!\n\n" +
      "Heard a health claim from a friend, family member, or online and not sure if it's true? Just type it here in plain English or Pidgin, and I'll check it against verified facts from WHO, NCDC, and NPHCDA.\n\n" +
      "📍 Looking for nearby clinics or hospitals? Tap the '📍 Share Location for Nearby Hospitals' button below.\n\n" +
      "If I'm not sure, I'll say so honestly instead of guessing — and I'll flag it for our team to look into.\n\n" +
      "Try something like:\n" +
      "\"My aunty said herbs can cure malaria instead of drugs\"";

    const keyboard = {
      keyboard: [
        [{ text: "📍 Share Location for Nearby Hospitals", request_location: true }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    };

    sendTelegramMessage(chatId, introMessage, keyboard).catch((err) =>
      console.error(`❌ Failed to send intro message to chat ${chatId}:`, err)
    );
    return;
  }

  if (text.startsWith("/testlocation")) {
    const parts = text.split(" ").filter(Boolean);
    let testLat = 6.5244;
    let testLon = 3.3792;
    if (parts.length >= 3) {
      const parsedLat = parseFloat(parts[1] || "");
      const parsedLon = parseFloat(parts[2] || "");
      if (!isNaN(parsedLat) && !isNaN(parsedLon)) {
        testLat = parsedLat;
        testLon = parsedLon;
      }
    }

    (async () => {
      try {
        console.log(`⏳ Finding nearby hospitals for chat ${chatId} (test location: lat=${testLat}, lon=${testLon})...`);
        await handleNearbyHospitals(chatId, testLat, testLon);
      } catch (error) {
        console.error(`❌ Error finding nearby hospitals for chat ${chatId}:`, error);
        try {
          await sendTelegramMessage(
            chatId,
            "Sorry, I couldn't look up nearby hospitals right now. Please try again shortly."
          );
        } catch (fallbackError) {
          console.error(`❌ Failed to send fallback message to chat ${chatId}:`, fallbackError);
        }
      }
    })();
    return;
  }

  if (hasLocation) {
    (async () => {
      try {
        console.log(`⏳ Finding nearby hospitals for chat ${chatId}...`);
        await handleNearbyHospitals(chatId, location!.latitude, location!.longitude);
      } catch (error) {
        console.error(`❌ Error finding nearby hospitals for chat ${chatId}:`, error);
        try {
          await sendTelegramMessage(
            chatId,
            "Sorry, I couldn't look up nearby hospitals right now. Please try again shortly."
          );
        } catch (fallbackError) {
          console.error(`❌ Failed to send fallback message to chat ${chatId}:`, fallbackError);
        }
      }
    })();
    return;
  }

  (async () => {
    try {
      if (voice) {
        console.log(`⏳ Transcribing voice note for chat ${chatId}...`);
        text = await transcribeVoice(voice.file_id);
        console.log(`📝 Transcribed text: "${text}"`);
        if (!text) {
          await sendTelegramMessage(chatId, "Sorry, I couldn't understand that voice note. Could you try typing your question instead?");
          return;
        }
      }

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