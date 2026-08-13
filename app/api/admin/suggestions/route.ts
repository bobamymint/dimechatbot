import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/requireAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Defaults to "pending" (the normal review queue). Pass
  // ?status=rejected to see rejected ones — used by the "Rejected" tab
  // on /admin/suggestions so a mis-click can be undone via /restore
  // instead of being gone for good.
  const statusParam = req.nextUrl.searchParams.get("status");
  const status = statusParam === "rejected" ? "rejected" : "pending";

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("knowledge_suggestions")
    .select(
      "id, representative_question, occurrence_count, draft_answer, edited_answer, status, created_at"
    )
    .eq("status", status)
    .order(status === "pending" ? "occurrence_count" : "reviewed_at", {
      ascending: false,
    });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ suggestions: data });
}

// Saves the admin's edits to the draft text as they type, before they hit
// Approve/Reject. Doesn't touch status or document_chunks.
export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin();
  if (!admin.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const id = body?.id;
  const editedAnswer = body?.edited_answer;

  if (typeof id !== "string" || typeof editedAnswer !== "string") {
    return NextResponse.json(
      { error: "id and edited_answer are required" },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();
  const { error } = await supabase
    .from("knowledge_suggestions")
    .update({ edited_answer: editedAnswer })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
