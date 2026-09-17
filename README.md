# SabiHealth Bot 🌿🩺

A health fact-checking bot built with Bun, TypeScript, Supabase (PostgreSQL with `pgvector`), and Google Gemini AI embeddings (`text-embedding-004`).

---

## 🚀 Quick Start

### 1. Database Setup (Supabase)
1. Open your [Supabase Project Dashboard](https://supabase.com/dashboard).
2. Go to the **SQL Editor** tab.
3. Open and run the contents of [`schema.sql`](./schema.sql):
   - Enables the `vector` extension.
   - Creates the `fact_library` table with 768-dimension vector support.
   - Inserts 8 seeded health myths and facts (e.g. malaria herbs, antibiotics for colds, salt water cures).

### 2. Configure Environment Variables
Edit your [`.env`](./.env) file:
```env
# Get from Supabase -> Project Settings -> Database -> Connection string (URI)
DATABASE_URL=postgresql://postgres:[YOUR-PASSWORD]@[YOUR-HOST]:6543/postgres?pgbouncer=true

# Get from Google AI Studio: https://aistudio.google.com/apikey
GEMINI_API_KEY=your_gemini_api_key
```

### 3. Backfill Embeddings
Generate vector embeddings for all facts in `fact_library` using Gemini `text-embedding-004` and save them to Supabase:

```bash
bun run embed
# or
bun run embed-test.ts
```

### 4. Test Semantic Vector Matching
Run the test queries to find the closest matching myth and verified fact using pgvector's `<=>` cosine distance:

```bash
# Run default test suite (tests multiple variations)
bun run match

# Or test any custom question:
bun run match "my aunty said herbs can cure malaria instead of drugs"
bun run match "can hot agbo cure cold or flu?"
```

---

## 📁 Project Structure

- [`schema.sql`](./schema.sql): SQL table schema, pgvector setup, and 8 seeded health facts.
- [`embed-test.ts`](./embed-test.ts): Script to backfill 768-dimensional embeddings for facts.
- [`match-test.ts`](./match-test.ts): Script to perform vector similarity queries using pgvector (`<=>`).
- [`.env`](./.env): Secret keys and database credentials (ignored by git).
- [`.env.example`](./.env.example): Template for required environment variables.
- [`package.json`](./package.json): Dependencies (`express`, `pg`, `dotenv`, `@google/generative-ai`) and scripts.
