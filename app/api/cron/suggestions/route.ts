import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { draftAnswer } from "@/lib/draftAnswer";
import { embedText } from "@/lib/gemini";

export const runtime = "nodejs";
// Drafting several answers sequentially (one LLM call per new candidate),
// plus one embedding call per distinct question, can take a while — same
// 60s ceiling used elsewhere in this project on Vercel's Hobby plan.
export const maxDuration = 60;

// A question needs to have been asked at least this many times, with no
// relevant knowledge found, within the lookback window, to get proposed
// as a new knowledge suggestion.
const MIN_OCCURRENCES = 3;
const LOOKBACK_DAYS = 7;

// Cosine similarity above this counts two differently-worded questions
// as "the same question" — e.g. "ค่าธรรมเนียมเท่าไหร่" and
// "มีค่าธรรมเนียมไหม" both cluster together instead of each individually
// falling short of MIN_OCCURRENCES. Tuned conservatively (0.88): raise
// it if unrelated questions start getting merged together, lower it if
// obvious paraphrases are still ending up in separate suggestions.
const SIMILARITY_THRESHOLD = 0.88;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface Cluster {
  representative: string;
  embedding: number[];
  count: number;
}

/**
 * Scheduled by vercel.json to run nightly. Vercel automatically attaches
 * an "Authorization: Bearer <CRON_SECRET>" header to requests it makes to
 * scheduled cron routes (using the CRON_SECRET env var you set on the
 * project), so this checks that header to make sure nobody else can hit
 * this route and burn through LLM quota. See DEPLOYMENT.md.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: rows, error } = await supabase
    .from("chat_logs")
    .select("question")
    .eq("answered", false)
    .gte("created_at", since);

  if (error) {
    console.error("cron/suggestions: chat_logs query failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Step 1: exact-text counts first — free, no API calls, and catches
  // the common case (someone asking the literal same question) without
  // spending any embedding calls at all.
  const exactCounts = new Map<string, number>();
  for (const row of rows || []) {
    const q = (row.question || "").trim();
    if (!q) continue;
    exactCounts.set(q, (exactCounts.get(q) || 0) + 1);
  }

  if (exactCounts.size === 0) {
    return NextResponse.json({ ok: true, candidatesFound: 0, created: 0 });
  }

  // Step 2: merge near-duplicate phrasings (different words, same
  // meaning) using embedding similarity, so paraphrases of the same
  // question count toward one suggestion instead of splitting across
  // several that individually never reach MIN_OCCURRENCES. This embeds
  // each DISTINCT question once (not every occurrence), so cost scales
  // with how many different things were asked, not how many times.
  const distinctQuestions = [...exactCounts.entries()].sort((a, b) => b[1] - a[1]);

  const clusters: Cluster[] = [];
  for (const [question, count] of distinctQuestions) {
    let embedding: number[];
    try {
      embedding = await embedText(question, "RETRIEVAL_QUERY");
    } catch (err) {
      console.error("cron/suggestions: embed failed for", question, err);
      continue;
    }

    let matched: Cluster | undefined;
    let bestSimilarity = SIMILARITY_THRESHOLD;
    for (const cluster of clusters) {
      const sim = cosineSimilarity(embedding, cluster.embedding);
      if (sim > bestSimilarity) {
        matched = cluster;
        bestSimilarity = sim;
      }
    }

    if (matched) {
      matched.count += count;
    } else {
      clusters.push({ representative: question, embedding, count });
    }
  }

  const candidates = clusters.filter((c) => c.count >= MIN_OCCURRENCES);

  if (candidates.length === 0) {
    return NextResponse.json({ ok: true, candidatesFound: 0, created: 0 });
  }

  // Dedup against every existing suggestion (any status: pending,
  // approved, or rejected) — both exact text and semantic near-
  // duplicates, so a question close in meaning to one already
  // proposed/reviewed doesn't get proposed again under a slightly
  // different phrasing.
  const { data: existingRows, error: existingError } = await supabase
    .from("knowledge_suggestions")
    .select("representative_question");

  if (existingError) {
    console.error("cron/suggestions: existing suggestions query failed", existingError);
  }

  const existingEmbeddings: { question: string; embedding: number[] }[] = [];
  for (const row of existingRows || []) {
    try {
      const emb = await embedText(row.representative_question, "RETRIEVAL_QUERY");
      existingEmbeddings.push({ question: row.representative_question, embedding: emb });
    } catch (err) {
      console.error("cron/suggestions: embed existing suggestion failed", err);
    }
  }

  let created = 0;

  for (const cluster of candidates) {
    const isDuplicate = existingEmbeddings.some(
      (e) =>
        e.question === cluster.representative ||
        cosineSimilarity(cluster.embedding, e.embedding) > SIMILARITY_THRESHOLD
    );
    if (isDuplicate) continue;

    const { data: inserted, error: insertError } = await supabase
      .from("knowledge_suggestions")
      .insert({
        representative_question: cluster.representative,
        occurrence_count: cluster.count,
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      console.error("cron/suggestions: insert failed", insertError);
      continue;
    }

    try {
      const draft = await draftAnswer(cluster.representative);
      await supabase
        .from("knowledge_suggestions")
        .update({ draft_answer: draft })
        .eq("id", inserted.id);
    } catch (draftErr) {
      console.error("cron/suggestions: draftAnswer failed", draftErr);
    }

    created++;
  }

  return NextResponse.json({ ok: true, candidatesFound: candidates.length, created });
}
