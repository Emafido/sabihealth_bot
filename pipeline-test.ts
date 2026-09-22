import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const CONFIDENCE_THRESHOLD = 0.65;
const GROQ_CHAT_MODEL = "openai/gpt-oss-20b";

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 1000): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const isRetryable = err?.status === 503 || err?.status === 429;
    if (retries > 0 && isRetryable) {
      console.warn(`⚠️  Call failed (${err?.status}), retrying in ${delayMs}ms... (${retries} left)`);
      await new Promise((res) => setTimeout(res, delayMs));
      return withRetry(fn, retries - 1, delayMs * 2);
    }
    throw err;
  }
}

// Fast-path: catch obvious greetings without any API call at all
const GREETING_PATTERN = /^(hi|hello|hey|good\s?(morning|afternoon|evening|day)|how\s?far|howdy|sup|yo|thanks|thank\s?you)\b[\s!.?]*$/i;

function isObviousGreeting(text: string): boolean {
  return GREETING_PATTERN.test(text.trim());
}

interface GroqChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning?: string | null;
    };
  }>;
}

async function groqChat(systemPrompt: string, userPrompt: string, maxTokens = 300, reasoningEffort: "low" | "medium" | "high" = "low"): Promise<string> {
  return withRetry(async () => {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_CHAT_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.4,
        max_tokens: maxTokens,
        reasoning_effort: reasoningEffort,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      const err: any = new Error(`Groq chat failed (${res.status}): ${errText}`);
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as GroqChatCompletionResponse;
    const message = data.choices?.[0]?.message;
    return (message?.content || message?.reasoning || "").trim();
  });
}

// Embeddings stay on Gemini — no quota issues seen here, and gemini-embedding-001 is well-suited for this
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
  const systemPrompt = `Classify the user's message into exactly ONE word: GREETING, MEDICAL, or OTHER.
GREETING - greeting or pleasantry (e.g. "hi", "how are you", "thanks")
MEDICAL - mentions health, illness, medicine, treatment, symptoms, or a health rumor/claim
OTHER - anything else unrelated to health
Reply with ONLY the single category word, nothing else.`;

  const label = (await groqChat(systemPrompt, text, 100, "low")).toUpperCase();

  if (label.includes("GREETING")) return "GREETING";
  if (label.includes("MEDICAL")) return "MEDICAL";
  return "OTHER";
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
  const systemPrompt = `You are a WhatsApp/Telegram health-information assistant for Nigerian users, replying in plain, warm, simple language (mix of English and Pidgin is fine if the user's question suggests it).
If the verified fact confirms the user's claim is TRUE, affirm it clearly and warmly, adding useful context from the fact. If the verified fact shows the user's claim is FALSE or a myth, correct it gently without being preachy. Either way, cite the source naturally. Keep it short (3-5 sentences max), plain language, no medical jargon.`;

  const userPrompt = `User asked: "${userQuestion}"
Verified fact: "${fact}"
Source: ${source}`;

  return groqChat(systemPrompt, userPrompt, 300);
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
  if (isObviousGreeting(questionText)) {
    return "Hello! 🌿 I'm SabiHealth. Send me any health claim or rumor you've heard, and I'll check it against verified facts. For example: \"my aunty said herbs can cure malaria instead of drugs.\"";
  }

  // Classification (Groq) and embedding (Gemini) run in parallel — independent of each other
  const [intent, embedding] = await Promise.all([
    classifyIntent(questionText),
    embedQuery(questionText),
  ]);

  if (intent === "GREETING") {
    return "Hello! 🌿 I'm SabiHealth. Send me any health claim or rumor you've heard, and I'll check it against verified facts. For example: \"my aunty said herbs can cure malaria instead of drugs.\"";
  }

  if (intent === "OTHER") {
    return "I'm built specifically to check health claims and rumors — that one's outside what I can help with. Try asking me something like a health rumor you've heard, and I'll check it against verified facts.";
  }

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
  const start = Date.now();
  handleIncomingQuestion(testPhoneNumber, question)
    .then((reply) => {
      console.log("🤖 Bot reply:\n");
      console.log(reply);
      console.log(`\n⏱️  Took ${Date.now() - start}ms`);
      console.log("✅ Done. Check queries_log / submissions in Supabase to confirm logging.\n");
      process.exit(0);
    })
    .catch((err) => {
      console.error("❌ Pipeline error:", err);
      process.exit(1);
    });
}