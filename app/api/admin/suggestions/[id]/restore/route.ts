import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * Undo a Reject. Only works on suggestions still in "rejected" status —
 * once something has been Approved (and its text embedded into
 * document_chunks), there's nothing to "restore" here; delete the
 * resulting document from /admin/documents instead if it needs undoing.
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
    .select("status")
    .eq("id", id)
    .single();

  if (fetchError || !suggestion) {
    return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
  }
  if (suggestion.status !== "rejected") {
    return NextResponse.json(
      { error: `Can't restore a suggestion that's ${suggestion.status}` },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("knowledge_suggestions")
    .update({ status: "pending", reviewed_at: null, reviewed_by: null })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
