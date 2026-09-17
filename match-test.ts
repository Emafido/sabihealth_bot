import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

// Load environment variables from .env
dotenv.config();

const { DATABASE_URL, GEMINI_API_KEY } = process.env;

// Validate environment variables
if (!DATABASE_URL || DATABASE_URL.includes("your_supabase_connection_string")) {
  console.error("❌ Error: DATABASE_URL is not configured in .env");
  console.error("👉 Please add your Supabase connection string to .env");
  process.exit(1);
}

if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("your_gemini_api_key")) {
  console.error("❌ Error: GEMINI_API_KEY is not configured in .env");
  console.error("👉 Please get your API key from https://aistudio.google.com/apikey and add it to .env");
  process.exit(1);
}

// Initialize Supabase Postgres pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

interface MatchResult {
  id: number;
  myth: string;
  fact: string;
  category?: string;
  similarity: number;
}

/**
 * Searches fact_library for the most semantically relevant health facts using pgvector cosine similarity.
 */
async function findClosestFact(client: any, queryText: string, limit: number = 3): Promise<MatchResult[]> {
  // 1. Generate 768-dim embedding for query with gemini-embedding-001
  const embedResult = await embeddingModel.embedContent({
    content: { parts: [{ text: queryText }] },
    outputDimensionality: 768,
  } as any);
  const embeddingValues = embedResult.embedding.values;
  const vectorString = JSON.stringify(embeddingValues);

  // 2. Query database using pgvector cosine distance operator <=>
  // Cosine Similarity = 1 - (embedding <=> query_vector)
  const sql = `
    SELECT 
      id, 
      myth, 
      fact, 
      category, 
      (1 - (embedding <=> $1::vector)) AS similarity
    FROM fact_library
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector ASC
    LIMIT $2;
  `;

  const res = await client.query(sql, [vectorString, limit]);
  return res.rows.map((row: any) => ({
    id: row.id,
    myth: row.myth,
    fact: row.fact,
    category: row.category,
    similarity: parseFloat(row.similarity),
  }));
}

async function runMatchTests() {
  const client = await pool.connect();

  try {
    console.log("📡 Connected to Supabase Postgres database successfully.");

    // Check if user passed a custom query via CLI arguments
    const cliQuery = process.argv.slice(2).join(" ").trim();

    // Default sample questions to test matching robustness with different phrasings
    const testQueries = cliQuery
      ? [cliQuery]
      : [
          "my aunty said herbs can cure malaria instead of drugs",
          "can agbo or traditional herbal tea cure malaria?",
          "people say taking antibiotics cures common cold and flu",
          "can drinking raw salt water treat food poisoning or infection?",
        ];

    console.log(`\n🧪 Testing ${testQueries.length} query scenario(s) against fact_library:\n${"=".repeat(70)}`);

    for (let i = 0; i < testQueries.length; i++) {
      const query = testQueries[i];
      if (!query) continue;

      console.log(`\n🔎 Query #${i + 1}: "${query}"`);

      const matches = await findClosestFact(client, query, 2);

      if (matches.length === 0 || !matches[0]) {
        console.log("⚠️  No matches found. Make sure facts exist and have embeddings backfilled.");
        continue;
      }

      const topMatch = matches[0];
      const confidencePercent = (topMatch.similarity * 100).toFixed(2);

      console.log(`🎯 Top Match [#${topMatch.id}] (Similarity: ${confidencePercent}%):`);
      console.log(`   Myth: "${topMatch.myth}"`);
      console.log(`   Fact: "${topMatch.fact}"`);
      if (topMatch.category) {
        console.log(`   Category: [${topMatch.category}]`);
      }

      const runnerUp = matches[1];
      if (runnerUp) {
        console.log(`   🥈 Runner-up [#${runnerUp.id}] (${(runnerUp.similarity * 100).toFixed(2)}%): "${runnerUp.myth}"`);
      }
      console.log("-".repeat(70));
    }
  } catch (error) {
    console.error("❌ Error running match tests:", error);
  } finally {
    client.release();
    await pool.end();
  }
}

runMatchTests();
