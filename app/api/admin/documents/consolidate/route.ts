import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText } from "@/lib/gemini";
import { chunkText } from "@/lib/chunk";

export const runtime = "nodejs";
// Re-embedding potentially many combined chunks can take a while.
export const maxDuration = 60;

/**
 * Every approved knowledge suggestion becomes its own small "document"
 * (see app/api/admin/suggestions/[id]/approve/route.ts) so it's easy to
 * spot-check and delete individually. Over time that can pile up into a
 * long, hard-to-scan list on /admin/documents. This is a manually-
 * triggered cleanup: it gathers every suggestion-sourced document,
 * combines them into one Q&A-style document, re-embeds that as a
 * single document, and deletes the small originals — same knowledge,
 * fewer rows to scroll through. Nothing is lost: the combined document
 * still contains every question and its approved answer.
 */
export async function POST(_req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: sourceDocs, error: docsError } = await supabase
    .from("documents")
    .select("id, title")
    .eq("filename", "admin-approved-suggestion")
    .eq("status", "ready")
    .order("created_at", { ascending: true });

  if (docsError) {
    return NextResponse.json({ error: docsError.message }, { status: 500 });
  }

  if (!sourceDocs || sourceDocs.length < 2) {
    return NextResponse.json({
      ok: true,
      merged: 0,
      message: "Nothing to consolidate — need at least 2 approved suggestions.",
    });
  }

  // Reconstruct each source document's full text (chunks were split for
  // embedding, not for meaning) and format as one Q&A block per document.
  const qaBlocks: string[] = [];
  for (const doc of sourceDocs) {
    const { data: chunks, error: chunksError } = await supabase
      .from("document_chunks")
      .select("content, chunk_index")
      .eq("document_id", doc.id)
      .order("chunk_index", { ascending: true });

    if (chunksError || !chunks || chunks.length === 0) continue;

    const question = doc.title.replace(/^\[Suggested\]\s*/, "");
    const answer = chunks.map((c) => c.content).join("\n");
    qaBlocks.push(`Q: ${question}\nA: ${answer}`);
  }

  if (qaBlocks.length === 0) {
    return NextResponse.json({ ok: true, merged: 0, message: "Nothing to consolidate." });
  }

  const combinedText = qaBlocks.join("\n\n");
  const dateLabel = new Date().toISOString().slice(0, 10);

  try {
    const { data: newDoc, error: newDocError } = await supabase
      .from("documents")
      .insert({
        title: `[Suggested] Consolidated FAQ (${qaBlocks.length} questions, ${dateLabel})`,
        filename: "admin-approved-suggestion",
        status: "processing",
      })
      .select()
      .single();

    if (newDocError || !newDoc) {
      throw new Error(newDocError?.message || "Failed to create consolidated document");
    }

    const chunks = chunkText(combinedText);
    const rows = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = await embedText(chunks[i], "RETRIEVAL_DOCUMENT");
      rows.push({
        document_id: newDoc.id,
        content: chunks[i],
        chunk_index: i,
        embedding: vector,
      });
    }

    const { error: insertChunksError } = await supabase.from("document_chunks").insert(rows);
    if (insertChunksError) throw new Error(insertChunksError.message);

    await supabase.from("documents").update({ status: "ready" }).eq("id", newDoc.id);

    // Delete the small originals now that their content lives in the
    // combined document — document_chunks cascades on document delete.
    const oldIds = sourceDocs.map((d) => d.id);
    await supabase.from("documents").delete().in("id", oldIds);

    return NextResponse.json({
      ok: true,
      merged: qaBlocks.length,
      newDocumentId: newDoc.id,
      chunkCount: rows.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Consolidate failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
