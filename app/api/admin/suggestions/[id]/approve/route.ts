import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText } from "@/lib/gemini";
import { chunkText } from "@/lib/chunk";

export const runtime = "nodejs";
// Embedding can take a few seconds per chunk, same as the document
// upload route this mirrors.
export const maxDuration = 60;

/**
 * Approving a suggestion is the ONLY place in this whole feature where
 * AI-generated text is embedded and written into document_chunks (the
 * bot's real, searchable knowledge) — and it only runs when an admin
 * explicitly clicks Approve on /admin/suggestions, using whatever text
 * is in the box at that moment (their edits, if any; the raw AI draft
 * otherwise). Mirrors app/api/admin/upload/route.ts's embedding step.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createAdminClient();

  const { data: suggestion, error: fetchError } = await supabase
    .from("knowledge_suggestions")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchError || !suggestion) {
    return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
  }
  if (suggestion.status !== "pending") {
    return NextResponse.json(
      { error: `Already ${suggestion.status}` },
      { status: 400 }
    );
  }

  const finalText = (suggestion.edited_answer || suggestion.draft_answer || "").trim();
  if (!finalText) {
    return NextResponse.json({ error: "No answer text to approve" }, { status: 400 });
  }

  try {
    // Filed as its own "document" (rather than a bare, source-less
    // document_chunks row — document_chunks has no column to mark where
    // a chunk came from) so it shows up in /admin/documents alongside
    // uploaded files, with a title that flags it as suggestion-sourced,
    // and can be deleted the same way as any other document if it
    // later turns out to be wrong.
    const { data: doc, error: docError } = await supabase
      .from("documents")
      .insert({
        title: `[Suggested] ${suggestion.representative_question}`.slice(0, 200),
        filename: "admin-approved-suggestion",
        status: "processing",
      })
      .select()
      .single();

    if (docError || !doc) {
      throw new Error(docError?.message || "Failed to create document row");
    }

    const chunks = chunkText(finalText);
    const rows = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = await embedText(chunks[i], "RETRIEVAL_DOCUMENT");
      rows.push({
        document_id: doc.id,
        content: chunks[i],
        chunk_index: i,
        embedding: vector,
      });
    }

    const { error: chunksError } = await supabase.from("document_chunks").insert(rows);
    if (chunksError) throw new Error(chunksError.message);

    await supabase.from("documents").update({ status: "ready" }).eq("id", doc.id);

    await supabase
      .from("knowledge_suggestions")
      .update({
        status: "approved",
        reviewed_at: new Date().toISOString(),
        reviewed_by: admin.user?.email ?? null,
      })
      .eq("id", id);

    return NextResponse.json({ ok: true, documentId: doc.id, chunkCount: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Approve failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
