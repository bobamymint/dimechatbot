# Dime chatbot

A minimal chatbot that answers questions using only knowledge you upload — built with Next.js, Supabase (Postgres + pgvector + Auth), and the Google Gemini API.

- `/` — public chat interface
- `/admin` — private dashboard (login required) for uploading and managing the bot's knowledge (PDF, DOCX, TXT, MD)

See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full step-by-step guide to setting up Supabase, getting a free Gemini API key, and deploying to Vercel.

## Local development

1. Copy `.env.example` to `.env.local` and fill in your Supabase and Gemini credentials (see DEPLOYMENT.md Steps 1–5).
2. Install dependencies and run the dev server:

   ```bash
   npm install
   npm run dev
   ```

3. Open [http://localhost:3000](http://localhost:3000) for the chat UI, and [http://localhost:3000/admin/login](http://localhost:3000/admin/login) to sign in and upload knowledge.

## Project structure

```
app/
  page.tsx                 chat UI
  admin/                   admin login + knowledge dashboard
  api/chat/                RAG chat endpoint (retrieval + Gemini streaming)
  api/admin/upload/        document parsing, chunking, embedding
  api/admin/documents/     list/delete documents
lib/
  supabase/                browser, server, and admin Supabase clients
  gemini.ts                embeddings + streaming chat helpers
  chunk.ts                 text chunking for indexing
  parse.ts                 PDF/DOCX/TXT/MD text extraction
  config.ts                site name, tagline, branding hooks
supabase/migrations/       SQL schema (pgvector tables + search function)
proxy.ts                   protects /admin routes (Next.js "proxy"/middleware)
```

## How answers stay grounded in your knowledge

Every question is embedded and matched against your uploaded content in Supabase (pgvector cosine similarity search). Only the top matching chunks are handed to Gemini, along with a system prompt instructing it to answer solely from that content and say "I don't know" otherwise — it does not fall back on general knowledge.
