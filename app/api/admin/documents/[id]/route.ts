import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText } from "@/lib/gemini";
import { chunkText } from "@/lib/chunk";

export const runtime = "nodejs";
// Re-embedding on save can take a few seconds for a longer document
// (e.g. a merged FAQ with many chunks).
export const maxDuration = 60;

/**
 * Reconstructs a document's full text by joining its chunks back
 * together in order. Used to pre-fill the edit box on /admin/documents
 * — chunk boundaries were chosen for embedding, not for reading, so
 * this is the closest thing to "the original text" available once a
 * document only exists as chunks (uploads aren't stored as files
 * anywhere; approved suggestions never were files to begin with).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createAdminClient();

  const { data: chunks, error } = await supabase
    .from("document_chunks")
    .select("content, chunk_index")
    .eq("document_id", id)
    .order("chunk_index", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ text: (chunks || []).map((c) => c.content).join("\n\n") });
}

/**
 * Saves edited text: re-chunks and re-embeds it from scratch, replacing
 * every existing chunk for this document. This is the general "edit
 * this document's knowledge" path — works the same whether it's a
 * single approved suggestion or a merged multi-question FAQ document;
 * for a merged document, find the Q&A block that needs updating inside
 * the full text and edit just that part before saving.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const text = body?.text;

  if (typeof text !== "string" || !text.trim()) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const supabase = createAdminClient();

  try {
    await supabase.from("documents").update({ status: "processing" }).eq("id", id);
    await supabase.from("document_chunks").delete().eq("document_id", id);

    const chunks = chunkText(text);
    const rows = [];
    for (let i = 0; i < chunks.length; i++) {
      const vector = await embedText(chunks[i], "RETRIEVAL_DOCUMENT");
      rows.push({ document_id: id, content: chunks[i], chunk_index: i, embedding: vector });
    }

    const { error: insertError } = await supabase.from("document_chunks").insert(rows);
    if (insertError) throw new Error(insertError.message);

    await supabase.from("documents").update({ status: "ready" }).eq("id", id);

    return NextResponse.json({ ok: true, chunkCount: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Save failed";
    await supabase.from("documents").update({ status: "failed", error: message }).eq("id", id);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const supabase = createAdminClient();

  // document_chunks has ON DELETE CASCADE on document_id, so deleting
  // the document row also removes its chunks/embeddings.
  const { error } = await supabase.from("documents").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
