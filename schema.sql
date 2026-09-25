-- SabiHealth Bot: Complete Database Schema & Seed Data for Supabase
-- Run this in your Supabase SQL Editor (https://supabase.com/dashboard/project/_/sql)

-- 1. Enable the pgvector extension to work with vector embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Create the fact_library table
CREATE TABLE IF NOT EXISTS fact_library (
    id SERIAL PRIMARY KEY,
    myth TEXT NOT NULL,
    fact TEXT NOT NULL,
    category TEXT,
    embedding VECTOR(768), -- gemini-embedding-001 uses 768 dimensions
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Create vector similarity search index (HNSW for high-speed nearest-neighbor search)
CREATE INDEX IF NOT EXISTS fact_library_embedding_idx 
ON fact_library USING hnsw (embedding vector_cosine_ops);

-- 4. Create submissions table (for unverified rumors / human-in-the-loop escalation)
CREATE TABLE IF NOT EXISTS submissions (
    id SERIAL PRIMARY KEY,
    phone_number TEXT,
    rumor_text TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'reviewed', 'verified', 'dismissed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Create queries_log table (audit trail, confidence tracking & analytics)
CREATE TABLE IF NOT EXISTS queries_log (
    id SERIAL PRIMARY KEY,
    phone_number TEXT NOT NULL,
    question_text TEXT NOT NULL,
    matched_fact_id INTEGER REFERENCES fact_library(id) ON DELETE SET NULL,
    confidence_score NUMERIC DEFAULT 0,
    escalated BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. Indexes for analytics and performance
CREATE INDEX IF NOT EXISTS idx_queries_log_phone ON queries_log(phone_number);
CREATE INDEX IF NOT EXISTS idx_queries_log_created_at ON queries_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

-- 7. Seed 8 common Nigerian/African health myths and verified facts (if empty)
INSERT INTO fact_library (myth, fact, category)
SELECT * FROM (VALUES
    (
        'Traditional herbs and concoctions (agbo) can completely cure malaria without modern antimalarial medication.',
        'Herbs may temporarily relieve fever symptoms, but Artemisinin-based Combination Therapy (ACT) approved by health authorities is required to clear malaria parasites from the bloodstream and prevent life-threatening complications.',
        'Malaria'
    ),
    (
        'Taking antibiotics like ampicillin or tetracycline cures the common cold, cough, and flu.',
        'Antibiotics only kill bacteria, whereas colds and flu are caused by viruses. Taking antibiotics unnecessarily causes antibiotic resistance and harmful side effects.',
        'Medications'
    ),
    (
        'Drinking salt water or bathing with saline solution prevents and cures viral infections like cholera and Ebola.',
        'Drinking concentrated salt water does not kill viruses or bacteria inside the body; instead, it can cause severe dehydration, dangerous electrolyte imbalance, kidney failure, and death.',
        'Infectious Disease'
    ),
    (
        'Stomach ulcers are caused solely by spicy food and skipping meals.',
        'Most peptic ulcers are caused by infection with Helicobacter pylori (H. pylori) bacteria or long-term use of NSAID pain relievers (like ibuprofen). Spicy food and stress may irritate symptoms but do not cause ulcers.',
        'Gastroenterology'
    ),
    (
        'Once your blood pressure numbers return to normal, you can stop taking your hypertension medications.',
        'Hypertension is usually a lifelong condition. Normal readings mean the medications are doing their job; stopping them abruptly can cause blood pressure spikes, stroke, or heart failure.',
        'Cardiovascular'
    ),
    (
        'Pouring cold water or placing ice on someone experiencing a high fever quickly cures it.',
        'Cold water or ice can induce shivering, which paradoxically drives internal body temperature higher and constricts blood vessels. Lukewarm sponging and appropriate antipyretics (like paracetamol) are safer.',
        'First Aid'
    ),
    (
        'Diabetes is caused solely by eating too much sugar and sweets.',
        'Diabetes is a complex metabolic disease influenced by genetics, insulin resistance, lifestyle, and pancreatic function. While high sugar intake contributes to weight gain, it is not the sole cause.',
        'Metabolism'
    ),
    (
        'Swallowing fruit seeds will cause a tree or plant to grow in your stomach or appendicitis.',
        'The human stomach contains strong hydrochloric acid and digestive enzymes that prevent seeds from germinating. Small fruit seeds pass harmlessly through the digestive tract.',
        'General Health'
    )
) AS v(myth, fact, category)
WHERE NOT EXISTS (SELECT 1 FROM fact_library LIMIT 1);
