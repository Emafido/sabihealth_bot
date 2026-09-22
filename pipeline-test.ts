import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const CONFIDENCE_THRESHOLD = 0.65;

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1000): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const isRetryable = err?.status === 503 || err?.status === 429;
    if (retries > 0 && isRetryable) {
      console.warn(`⚠️  Gemini call failed (${err?.status}), retrying in ${delayMs}ms... (${retries} left)`);
      await new Promise((res) => setTimeout(res, delayMs));
      return withRetry(fn, retries - 1, delayMs * 2);
    }
    throw err;
  }
}

async function embedQuery(text: string): Promise<number[]> {
  return withRetry(async () => {
    const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
    const result = await model.embedContent({
      content: { role: "user", parts: [{ text }] },
      outputDimensionality: 768,
    } as any);
    return result.embedding.values;
  });
}

async function classifyIntent(text: string): Promise<"GREETING" | "MEDICAL" | "OTHER"> {
  return withRetry(async () => {
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const prompt = `Classify the following message into exactly ONE of these categories. Reply with ONLY the category word, nothing else.

GREETING - if it's a greeting, small talk, or pleasantry (e.g. "hi", "hello", "good morning", "how are you", "thanks")
MEDICAL - if it mentions, asks about, or claims something related to health, illness, medicine, treatment, symptoms, or a health rumor
OTHER - anything else not related to health (e.g. asking for directions, prices, jokes, general chit-chat unrelated to health)

Message: "${text}"

Category:`;

    const result = await model.generateContent(prompt);
    const label = result.response.text().trim().toUpperCase();

    if (label.includes("GREETING")) return "GREETING";
    if (label.includes("MEDICAL")) return "MEDICAL";
    return "OTHER";
  });
}

async function findBestMatch(embedding: number[]) {
  const vectorLiteral = `[${embedding.join(",")}]`;
  const { rows } = await pool.query(
    `select id, myth, fact, category,
            (1 - (embedding <=> $1::vector)) as similarity
     from fact_library
     where embedding is not null
     order by embedding <=> $1::vector asc
     limit 1`,
    [vectorLiteral]
  );
  return rows[0] ?? null;
}

async function generateReply(fact: string, source: string, userQuestion: string): Promise<string> {
  return withRetry(async () => {
    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    const prompt = `You are a WhatsApp/Telegram health-information assistant for Nigerian users, replying in plain, warm, simple language (mix of English and Pidgin is fine if the user's question suggests it).
A user asked: "${userQuestion}"
The verified fact to base your reply on is: "${fact}"
Source: ${source}

If the verified fact confirms the user's claim is TRUE, affirm it clearly and warmly, adding useful context from the fact. If the verified fact shows the user's claim is FALSE or a myth, correct it gently without being preachy. Either way, cite the source naturally. Keep it short (3-5 sentences max), plain language, no medical jargon.`;

    const result = await model.generateContent(prompt);
    return result.response.text();
  });
}

async function logSubmission(phoneNumber: string, rumorText: string) {
  await pool.query(
    `insert into submissions (phone_number, rumor_text, status) values ($1, $2, 'pending')`,
    [phoneNumber, rumorText]
  );
}

async function logQuery(
  phoneNumber: string,
  questionText: string,
  matchedFactId: number | null,
  confidenceScore: number,
  escalated: boolean
) {
  await pool.query(
    `insert into queries_log (phone_number, question_text, matched_fact_id, confidence_score, escalated)
     values ($1, $2, $3, $4, $5)`,
    [phoneNumber, questionText, matchedFactId, confidenceScore, escalated]
  );
}

export async function handleIncomingQuestion(phoneNumber: string, questionText: string): Promise<string> {
  const intent = await classifyIntent(questionText);

  if (intent === "GREETING") {
    return "Hello! 🌿 I'm SabiHealth. Send me any health claim or rumor you've heard, and I'll check it against verified facts. For example: \"my aunty said herbs can cure malaria instead of drugs.\"";
  }

  if (intent === "OTHER") {
    return "I'm built specifically to check health claims and rumors — that one's outside what I can help with. Try asking me something like a health rumor you've heard, and I'll check it against verified facts.";
  }

  const embedding = await embedQuery(questionText);
  const match = await findBestMatch(embedding);

  const similarity = match ? parseFloat(match.similarity) : 0;

  if (match && similarity >= CONFIDENCE_THRESHOLD) {
    const reply = await generateReply(match.fact, match.category ?? "verified health source", questionText);
    await logQuery(phoneNumber, questionText, match.id, similarity, false);
    return reply;
  } else {
    await logSubmission(phoneNumber, questionText);
    await logQuery(phoneNumber, questionText, null, similarity, true);
    return "I don't have a confirmed answer for that yet — I've logged it for review by our team. In the meantime, please check with a qualified health worker for advice on this.";
  }
}

// CLI test runner: bun run pipeline-test.ts "your question here"
if (import.meta.main) {
  const question = process.argv[2] ?? "is it true that vaccines cause infertility";
  const testPhoneNumber = "test-cli-user";

  console.log(`\n🧪 Testing full pipeline with: "${question}"\n`);
  handleIncomingQuestion(testPhoneNumber, question)
    .then((reply) => {
      console.log("🤖 Bot reply:\n");
      console.log(reply);
      console.log("\n✅ Done. Check queries_log / submissions in Supabase to confirm logging.\n");
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Pipeline error:", err);
      process.exit(1);
    });
}