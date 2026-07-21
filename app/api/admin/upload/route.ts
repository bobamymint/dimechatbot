import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractText } from "@/lib/parse";
import { chunkText } from "@/lib/chunk";
import { embedTexts } from "@/lib/gemini";

export const runtime = "nodejs";
// Parsing + embedding a document can take a while on the free tier.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const titleField = formData.get("title");

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const title =
    typeof titleField === "string" && titleField.trim()
      ? titleField.trim()
      : file.name;

  const { data: doc, error: insertError } = await supabase
    .from("documents")
    .insert({ title, filename: file.name, status: "processing" })
    .select()
    .single();

  if (insertError || !doc) {
    return NextResponse.json(
      { error: insertError?.message || "Failed to create document" },
      { status: 500 }
    );
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const text = await extractText(buffer, file.name);
    const chunks = chunkText(text);

    if (chunks.length === 0) {
      throw new Error("No extractable text found in this file.");
    }

    const embeddings = await embedTexts(chunks);

    const rows = chunks.map((content, i) => ({
      document_id: doc.id,
      content,
      chunk_index: i,
      embedding: embeddings[i],
    }));

    const { error: chunksError } = await supabase.from("document_chunks").insert(rows);
    if (chunksError) throw new Error(chunksError.message);

    await supabase.from("documents").update({ status: "ready" }).eq("id", doc.id);

    return NextResponse.json({ ok: true, documentId: doc.id, chunkCount: rows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Processing failed";
    await supabase
      .from("documents")
      .update({ status: "failed", error: message })
      .eq("id", doc.id);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
