-- Dime chatbot: knowledge base schema
-- Run this once in the Supabase SQL editor (or via `supabase db push`).

-- 1. Enable the pgvector extension for embedding similarity search.
create extension if not exists vector;

-- 2. Documents table: one row per uploaded source (pdf/docx/txt).
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  filename text not null,
  status text not null default 'processing', -- processing | ready | failed
  error text,
  created_at timestamptz not null default now()
);

-- 3. Document chunks: the actual text pieces + embeddings used for
--    retrieval. gemini-embedding-001 is configured (see lib/gemini.ts)
--    to output 768-dimensional vectors, which keeps storage/search fast.
create table if not exists document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  content text not null,
  chunk_index int not null,
  embedding vector(768),
  created_at timestamptz not null default now()
);

create index if not exists document_chunks_document_id_idx
  on document_chunks(document_id);

-- Approximate nearest-neighbour index for fast cosine similarity search.
create index if not exists document_chunks_embedding_idx
  on document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- 4. RPC used by the chat API to retrieve the most relevant chunks for
--    a user's question. Runs with the service role key from the server,
--    so it does not need to be exposed through RLS to the public.
create or replace function match_document_chunks(
  query_embedding vector(768),
  match_count int default 6,
  similarity_threshold float default 0.5
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  similarity float
)
language sql stable
as $$
  select
    dc.id,
    dc.document_id,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  where dc.embedding is not null
    and 1 - (dc.embedding <=> query_embedding) > similarity_threshold
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;

-- 5. Row Level Security. The app talks to these tables only through
--    server-side code using the service role key (which bypasses RLS),
--    so we lock both tables down completely for the anon/public roles.
alter table documents enable row level security;
alter table document_chunks enable row level security;

-- No policies are created on purpose: with RLS enabled and zero
-- policies, the anon/authenticated roles get zero access, while the
-- service role (used server-side only) is unaffected by RLS.
