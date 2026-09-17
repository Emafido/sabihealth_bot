import { Pool } from "pg";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

// Load environment variables from .env
dotenv.config();

const { DATABASE_URL, GEMINI_API_KEY } = process.env;

// Validate environment variables
if (!DATABASE_URL || DATABASE_URL.includes("your_supabase_connection_string")) {
  console.error("❌ Error: DATABASE_URL is not configured in .env");
  console.error("👉 Please add your Supabase connection string to .env (Supabase -> Project Settings -> Database -> Connection string URI)");
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
// gemini-embedding-001 with Matryoshka learning truncated to 768 dimensions
const embeddingModel = genAI.getGenerativeModel({ model: "gemini-embedding-001" });

async function backfillEmbeddings() {
  const client = await pool.connect();

  try {
    console.log("📡 Connected to Supabase Postgres database successfully.");

    // Fetch all facts from fact_library
    console.log("🔍 Fetching rows from fact_library...");
    const result = await client.query("SELECT id, myth FROM fact_library ORDER BY id ASC;");

    if (result.rows.length === 0) {
      console.warn("⚠️  No rows found in fact_library table. Please ensure your facts are inserted first.");
      return;
    }

    console.log(`📋 Found ${result.rows.length} facts in fact_library. Starting embedding generation...\n`);

    let updatedCount = 0;

    for (const row of result.rows) {
      const { id, myth } = row;
      console.log(`[#${id}] Generating embedding for myth: "${myth}"`);

      try {
        // Generate 768-dim embedding with gemini-embedding-001
        const embedResult = await embeddingModel.embedContent({
          content: { parts: [{ text: myth }] },
          outputDimensionality: 768,
        } as any);
        const embeddingValues = embedResult.embedding.values;

        if (!embeddingValues || embeddingValues.length === 0) {
          throw new Error("No embedding values returned from Gemini API");
        }

        // Format embedding as pgvector literal string: '[0.0123, -0.0456, ...]'
        const vectorString = JSON.stringify(embeddingValues);

        // Update Postgres row with the new embedding
        await client.query(
          "UPDATE fact_library SET embedding = $1::vector WHERE id = $2;",
          [vectorString, id]
        );

        console.log(`✅ [#${id}] Embedding updated successfully (dimensions: ${embeddingValues.length})\n`);
        updatedCount++;
      } catch (embedError) {
        console.error(`❌ [#${id}] Failed to generate or save embedding for: "${myth}"`, embedError);
      }
    }

    console.log(`🎉 Embedding backfill completed: ${updatedCount}/${result.rows.length} rows updated successfully!`);
  } catch (error) {
    console.error("❌ Fatal error during backfill process:", error);
  } finally {
    client.release();
    await pool.end();
  }
}

backfillEmbeddings();
