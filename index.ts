import express, { type Request, type Response } from "express";
import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { handleIncomingQuestion } from "./pipeline-test";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.warn("⚠️  Warning: TELEGRAM_BOT_TOKEN is not set in .env. The bot cannot send replies without it.");
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Initialize Supabase JS client and Postgres Pool
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ualdjxgpazmryjnlzbnd.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.SUPABASE_KEY;

const supabase: SupabaseClient | null = (SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

if (supabase) {
  console.log("⚡ Supabase JS client initialized.");
} else {
  console.log("ℹ️  SUPABASE_KEY not set in environment; logging will use DATABASE_URL pool fallback.");
}

const dbPool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

async function saveQueryLog(params: {
  phoneNumber: string | number;
  questionText: string;
  matchedFactId?: number | null;
  confidenceScore?: number | null;
  escalated?: boolean;
}): Promise<void> {
  const {
    phoneNumber,
    questionText,
    matchedFactId = null,
    confidenceScore = 0,
    escalated = false,
  } = params;

  // 1. Try @supabase/supabase-js first if client is initialized
  if (supabase) {
    try {
      const { error } = await supabase.from("queries_log").insert({
        phone_number: String(phoneNumber),
        question_text: questionText,
        matched_fact_id: matchedFactId,
        confidence_score: confidenceScore,
        escalated: escalated,
      });
      if (error) {
        console.warn(`⚠️  @supabase/supabase-js insert warning: ${error.message}`);
      } else {
        console.log(`💾 Saved message to Supabase via supabase-js for chat ${phoneNumber}`);
        return;
      }
    } catch (err: any) {
      console.warn(`⚠️  @supabase/supabase-js insert error: ${err.message}`);
    }
  }

  // 2. Direct Postgres pool fallback
  if (dbPool) {
    try {
      await dbPool.query(
        `INSERT INTO queries_log (phone_number, question_text, matched_fact_id, confidence_score, escalated)
         VALUES ($1, $2, $3, $4, $5)`,
        [String(phoneNumber), questionText, matchedFactId, confidenceScore, escalated]
      );
      console.log(`💾 Saved message to Supabase via db pool for chat ${phoneNumber}`);
    } catch (dbErr: any) {
      console.error(`❌ Failed to save to Supabase queries_log: ${dbErr.message}`);
    }
  }
}

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

interface HospitalFacility {
  name: string;
  lat: number;
  lon: number;
  distanceKm: number;
}

async function fetchNearbyFacilities(userLat: number, userLon: number): Promise<HospitalFacility[]> {
  // 1. Primary: Query OpenStreetMap Overpass API
  const query = `[out:json][timeout:10];
(
  node["amenity"="hospital"](around:5000,${userLat},${userLon});
  node["amenity"="clinic"](around:5000,${userLat},${userLon});
);
out body;`;

  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
  ];

  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

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

      if (res.ok) {
        const text = await res.text();
        const data = JSON.parse(text) as OverpassResponse;
        if (data.elements && data.elements.length > 0) {
          return data.elements
            .filter((el) => typeof el.lat === "number" && typeof el.lon === "number")
            .map((el) => ({
              name: el.tags?.name?.trim() || "Unnamed hospital/clinic",
              lat: el.lat,
              lon: el.lon,
              distanceKm: calculateDistanceKm(userLat, userLon, el.lat, el.lon),
            }));
        }
      }
    } catch (err) {
      console.warn(`⚠️ Overpass query to ${endpoint} failed, trying backup...`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // 2. High-availability Fallback: OpenStreetMap Nominatim
  try {
    const delta = 0.05; // ~5km
    const minLon = userLon - delta;
    const minLat = userLat - delta;
    const maxLon = userLon + delta;
    const maxLat = userLat + delta;
    const viewbox = `${minLon},${maxLat},${maxLon},${minLat}`;

    const [hospRes, clinicRes] = await Promise.all([
      fetch(
        `https://nominatim.openstreetmap.org/search?amenity=hospital&format=json&lat=${userLat}&lon=${userLon}&bounded=1&viewbox=${viewbox}&limit=10`,
        { headers: { "User-Agent": "SabiHealthBot/1.0 (+https://t.me/sabihealth)" } }
      ),
      fetch(
        `https://nominatim.openstreetmap.org/search?amenity=clinic&format=json&lat=${userLat}&lon=${userLon}&bounded=1&viewbox=${viewbox}&limit=10`,
        { headers: { "User-Agent": "SabiHealthBot/1.0 (+https://t.me/sabihealth)" } }
      ),
    ]);

    const hospData = hospRes.ok ? await hospRes.json() : [];
    const clinicData = clinicRes.ok ? await clinicRes.json() : [];
    const combined = [...(Array.isArray(hospData) ? hospData : []), ...(Array.isArray(clinicData) ? clinicData : [])];

    if (combined.length > 0) {
      return combined
        .map((item: any) => {
          const lat = parseFloat(item.lat);
          const lon = parseFloat(item.lon);
          const name = item.name || item.display_name?.split(",")[0] || "Unnamed hospital/clinic";
          return {
            name,
            lat,
            lon,
            distanceKm: calculateDistanceKm(userLat, userLon, lat, lon),
          };
        })
        .filter((item) => !isNaN(item.lat) && !isNaN(item.lon));
    }
  } catch (nomErr) {
    console.warn("⚠️ OSM Nominatim fallback also failed:", nomErr);
  }

  return [];
}

async function handleNearbyHospitals(chatId: number | string, userLat: number, userLon: number): Promise<void> {
  const withDistance = await fetchNearbyFacilities(userLat, userLon);

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

  const reply = `Here are the closest hospitals/clinics I found:\n\n${itemsText}\n\n🚨 If it's urgent, please call emergency services (112, or 767 in Lagos) or go to the nearest facility right away.`;

  await sendTelegramMessage(chatId, reply);
  console.log(`📤 Reply sent to chat ${chatId} (found ${closest.length} nearby facilities)`);

  await saveQueryLog({
    phoneNumber: chatId,
    questionText: `[Location shared: lat=${userLat}, lon=${userLon}]`,
    confidenceScore: 1.0,
    escalated: false,
  });
}

function isHospitalOrDoctorRequest(text: string): boolean {
  const clean = text.toLowerCase().trim();

  // Facility keywords
  const facilityKeywords = /\b(hospital|clinic|doctor|pharmacy|chemist|health\s?cent(er|re)|medical\s?cent(er|re)|emergency\s?room|er|urgent\s?care)\b/i;

  // Action or care-seeking keywords
  const actionKeywords = /\b(get\s?to|go\s?to|find|locate|nearest|near\s?me|closest|around|where\s?is|where\s?can|see\s?a|visit|need|want|look(ing)?\s?for|take\s?me|reach|search|call)\b/i;

  // Direct short queries
  const directQueries = /^(hospital|clinic|doctor|nearby\s?hospital|nearby\s?clinic|find\s?hospital|hospital\s?near\s?me)[\s!.?]*$/i;

  if (directQueries.test(clean)) {
    return true;
  }

  return facilityKeywords.test(clean) && actionKeywords.test(clean);
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

  if (
    text === "📍 Share Location for Nearby Hospitals" ||
    text.toLowerCase() === "share location"
  ) {
    const webNotice =
      "📍 You are on Telegram Web or Desktop, which does not support one-tap GPS sharing.\n\n" +
      "👉 To find nearby hospitals right now, type:\n" +
      "/testlocation\n\n" +
      "(Or type /testlocation <latitude> <longitude> to test specific coordinates).\n\n" +
      "📱 On mobile, tap the paperclip icon (📎) or the button to share your live GPS location.";
    sendTelegramMessage(chatId, webNotice).catch((err) =>
      console.error(`❌ Failed to send web location notice to chat ${chatId}:`, err)
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

  if (isHospitalOrDoctorRequest(text)) {
    const hospitalPrompt =
      "🏥 To help you find the closest hospitals and clinics near you, please share your location!\n\n" +
      "📱 On mobile: Tap the '📍 Share Location for Nearby Hospitals' button below (or tap the paperclip 📎 and select Location).\n\n" +
      "💻 On Web/Desktop: Type /testlocation to find facilities.\n\n" +
      "🚨 If this is a medical emergency, please call 112 (National Emergency toll-free) or 767 (in Lagos) immediately, or go to the nearest emergency room right away.";

    const keyboard = {
      keyboard: [
        [{ text: "📍 Share Location for Nearby Hospitals", request_location: true }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    };

    (async () => {
      try {
        await sendTelegramMessage(chatId, hospitalPrompt, keyboard);
        console.log(`📤 Hospital guidance & emergency info sent to chat ${chatId}`);
        await saveQueryLog({
          phoneNumber: chatId,
          questionText: text,
          escalated: true,
        });
      } catch (err) {
        console.error(`❌ Failed to send hospital guidance to chat ${chatId}:`, err);
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

      await saveQueryLog({
        phoneNumber: chatId,
        questionText: text,
      });
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