# Deploying your Dime chatbot

This guide walks through every step to get the chatbot live on the internet, using accounts you've already created on **Vercel** and **Supabase**, plus a free **Google Gemini** API key.

Rough time: 30–45 minutes the first time.

## How it all fits together

- **Frontend** (`/`): a minimal chat page anyone can visit and ask questions.
- **Backend** (`/admin`): a password-protected page only you can log into, where you upload documents (PDF/DOCX/TXT/MD) that become the bot's knowledge.
- **Supabase**: stores your documents, their text chunks, and the "embeddings" (search vectors) used to find relevant knowledge for each question. Also handles your admin login.
- **Gemini API** (free tier): turns text into embeddings for search, and generates the chatbot's answers, strictly grounded in whatever you've uploaded.
- **Vercel**: hosts the actual website and runs the backend code.

Nothing in this stack requires a paid plan to get started.

---

## Step 1 — Create your Supabase project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard) and click **New project**.
2. Pick an organization, name the project (e.g. `dime-chatbot`), set a database password (save it somewhere safe — you likely won't need it directly, but keep it), choose the region closest to your users, and click **Create new project**.
3. Wait ~2 minutes for it to finish provisioning.

## Step 2 — Enable pgvector and create the database tables

1. In your Supabase project, open the **SQL Editor** (left sidebar).
2. Click **New query**.
3. Open the file `supabase/migrations/0001_init.sql` from this project, copy its entire contents, and paste it into the SQL editor.
4. Click **Run**. You should see "Success. No rows returned."

This creates:
- The `documents` table (one row per uploaded file)
- The `document_chunks` table (the text pieces + search vectors)
- A `match_document_chunks` search function
- Row Level Security locked down so only server-side code (using the service role key) can read/write this data

## Step 3 — Get your Supabase API keys

1. In Supabase, go to **Project Settings → API**.
2. Copy these three values — you'll need them in Step 7:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **anon public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - **service_role key** (click "reveal") → `SUPABASE_SERVICE_ROLE_KEY`

The service role key is powerful — it bypasses all security rules. Never put it in frontend code or share it. This project only ever uses it inside server-side API routes.

## Step 4 — Create your admin login

1. In Supabase, go to **Authentication → Users**.
2. Click **Add user → Create new user**.
3. Enter your email and a password, and make sure **Auto Confirm User** is checked (so you don't need to click an email confirmation link).
4. Click **Create user**.

This is the email/password you'll use to log into `/admin` on your live site. You'll allow-list this email in Step 7 (`ADMIN_EMAILS`) — only allow-listed emails can access the admin panel, even if someone else creates a Supabase account.

## Step 5 — Get a free Gemini API key

1. Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Sign in with a Google account and click **Create API key**.
3. Copy the key → this is `GEMINI_API_KEY`.

The free tier is generous for a small knowledge-base chatbot, but if you expect heavy traffic, check current limits at [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing) before launch.

## Step 6 — Push the code to GitHub

Vercel deploys from a Git repository.

```bash
cd dime-chatbot
git init
git add .
git commit -m "Initial commit"
```

Then create a new repository on [github.com/new](https://github.com/new) (keep it private if you'd like), and push:

```bash
git remote add origin https://github.com/YOUR-USERNAME/dime-chatbot.git
git branch -M main
git push -u origin main
```

## Step 7 — Import the project into Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repository you just pushed.
2. Vercel will auto-detect it as a Next.js project — leave the build settings as default.
3. Before deploying, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | from Step 3 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Step 3 |
| `SUPABASE_SERVICE_ROLE_KEY` | from Step 3 |
| `GEMINI_API_KEY` | from Step 5 |
| `GEMINI_CHAT_MODEL` | `gemini-2.5-flash` |
| `GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` |
| `ADMIN_EMAILS` | the email you created in Step 4 |

4. Click **Deploy**. Vercel will build and deploy the site — this takes about 1–2 minutes.

## Step 8 — Verify it works

1. Visit your new `*.vercel.app` URL — you should see the chat page.
2. Visit `/admin/login` and sign in with the email/password from Step 4.
3. Upload a small `.txt` file with a couple of sentences as a test (e.g. "Our support hours are 9am–6pm on weekdays.").
4. Wait for its status to say **ready**.
5. Go back to the chat page and ask a question it should be able to answer from that file. Then ask something unrelated — it should say it doesn't have that information, rather than making something up.

## Updating the knowledge base later

Any time you want to add or refresh information: log into `yourdomain.com/admin`, upload a document, and it's searchable within seconds. To remove outdated info, delete the document from the same screen — its chunks are removed automatically.

## Optional: custom domain

In Vercel, go to your project → **Settings → Domains** and add your domain, then follow Vercel's DNS instructions with your domain registrar.

## Customizing the look

- `lib/config.ts` — site name, tagline, and the fallback message shown when the bot doesn't know something.
- `tailwind.config.ts` — the `brand` (navy) and `accent` (gold) colors are placeholders inspired by a minimal fintech look. Swap in Dime's exact brand colors here once you have them, and the whole UI updates.

## Notes on the free tier

- **Gemini free tier** has daily/per-minute request caps. If you hit them, requests will briefly fail — the chat UI shows a friendly error rather than crashing.
- **Supabase free tier** pauses projects after a week of inactivity; visiting the dashboard or getting real traffic wakes it back up.
- If you outgrow either free tier, both offer inexpensive pay-as-you-go plans without needing to change any code.
