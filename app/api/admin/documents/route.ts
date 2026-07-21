import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET() {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: documents, error } = await supabase
    .from("documents")
    .select("id, title, filename, status, error, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data: chunkCounts } = await supabase
    .from("document_chunks")
    .select("document_id");

  const counts = new Map<string, number>();
  for (const row of chunkCounts || []) {
    counts.set(row.document_id, (counts.get(row.document_id) || 0) + 1);
  }

  const withCounts = (documents || []).map((doc) => ({
    ...doc,
    chunkCount: counts.get(doc.id) || 0,
  }));

  return NextResponse.json({ documents: withCounts });
}
