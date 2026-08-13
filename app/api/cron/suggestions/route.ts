import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { draftAnswer } from "@/lib/draftAnswer";

export const runtime = "nodejs";
// Drafting several answers sequentially (one LLM call per new candidate)
// can take a while — same 60s ceiling used elsewhere in this project on
// Vercel's Hobby plan.
export const maxDuration = 60;

// A question needs to have been asked at least this many times, with no
// relevant knowledge found, within the lookback window, to get proposed
// as a new knowledge suggestion.
const MIN_OCCURRENCES = 3;
const LOOKBACK_DAYS = 7;

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

  // Note: this groups by EXACT question text, same limitation called out
  // in the original spec — "ค่าธรรมเนียมเท่าไหร่" and "มีค่าธรรมเนียมไหม"
  // are counted separately even though they mean the same thing.
  // Grouping by embedding similarity is a possible future improvement;
  // not needed to get real value out of this feature today.
  const { data: rows, error } = await supabase
    .from("chat_logs")
    .select("question")
    .eq("answered", false)
    .gte("created_at", since);

  if (error) {
    console.error("cron/suggestions: chat_logs query failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const counts = new Map<string, number>();
  for (const row of rows || []) {
    const q = (row.question || "").trim();
    if (!q) continue;
    counts.set(q, (counts.get(q) || 0) + 1);
  }

  const candidates = [...counts.entries()].filter(
    ([, count]) => count >= MIN_OCCURRENCES
  );

  let created = 0;

  for (const [question, occurrenceCount] of candidates) {
    // Skip if a suggestion for this exact question already exists in any
    // status (pending/approved/rejected) — this both avoids duplicate
    // pending cards and stops a previously-rejected question from
    // reappearing every night, per the original spec.
    const { data: existing, error: existingError } = await supabase
      .from("knowledge_suggestions")
      .select("id")
      .eq("representative_question", question)
      .limit(1);

    if (existingError) {
      console.error("cron/suggestions: existing-check failed", existingError);
      continue;
    }
    if (existing && existing.length > 0) continue;

    const { data: inserted, error: insertError } = await supabase
      .from("knowledge_suggestions")
      .insert({
        representative_question: question,
        occurrence_count: occurrenceCount,
      })
      .select("id")
      .single();

    if (insertError || !inserted) {
      console.error("cron/suggestions: insert failed", insertError);
      continue;
    }

    try {
      const draft = await draftAnswer(question);
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
