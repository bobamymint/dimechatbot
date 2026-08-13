"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { siteConfig } from "@/lib/config";

interface SuggestionRow {
  id: string;
  representative_question: string;
  occurrence_count: number;
  draft_answer: string | null;
  edited_answer: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

export default function SuggestionsPage() {
  const [suggestions, setSuggestions] = useState<SuggestionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const router = useRouter();

  const loadSuggestions = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/suggestions");
    if (res.ok) {
      const data = await res.json();
      const rows: SuggestionRow[] = data.suggestions;
      setSuggestions(rows);
      setDrafts((prev) => {
        const next = { ...prev };
        for (const row of rows) {
          if (!(row.id in next)) {
            next[row.id] = row.edited_answer ?? row.draft_answer ?? "";
          }
        }
        return next;
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  async function handleApprove(id: string) {
    setBusyId(id);
    setErrorById((prev) => ({ ...prev, [id]: "" }));

    // Save any edits first so approve always uses the latest text in the box.
    await fetch("/api/admin/suggestions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, edited_answer: drafts[id] ?? "" }),
    });

    const res = await fetch(`/api/admin/suggestions/${id}/approve`, { method: "POST" });
    setBusyId(null);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setErrorById((prev) => ({ ...prev, [id]: data.error || "Approve failed" }));
      return;
    }

    setSuggestions((prev) => prev.filter((s) => s.id !== id));
  }

  async function handleReject(id: string) {
    if (!confirm("Reject this suggestion? It won't be proposed again automatically.")) return;
    setBusyId(id);
    setErrorById((prev) => ({ ...prev, [id]: "" }));

    const res = await fetch(`/api/admin/suggestions/${id}/reject`, { method: "POST" });
    setBusyId(null);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setErrorById((prev) => ({ ...prev, [id]: data.error || "Reject failed" }));
      return;
    }

    setSuggestions((prev) => prev.filter((s) => s.id !== id));
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/admin/login");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink-950">
            {siteConfig.name} — Suggested knowledge
          </h1>
          <p className="text-xs text-ink-950/50">
            Questions asked repeatedly that the bot couldn&apos;t answer. Review, edit if
            needed, then approve to add to the knowledge base — or reject to dismiss.
          </p>
        </div>
        <button
          onClick={handleSignOut}
          className="text-xs font-medium text-ink-950/50 hover:text-ink-950"
        >
          Sign out
        </button>
      </header>

      <nav className="mb-6 flex gap-4 text-xs font-medium">
        <Link href="/admin/documents" className="text-ink-950/50 hover:text-ink-950">
          Documents
        </Link>
        <span className="text-brand">Suggestions</span>
      </nav>

      <div className="space-y-4">
        {loading && <p className="text-sm text-ink-950/40">Loading…</p>}
        {!loading && suggestions.length === 0 && (
          <p className="text-sm text-ink-950/40">
            No pending suggestions right now. They show up here after a question has been
            asked 3+ times in a week with no answer — checked once a night.
          </p>
        )}

        {suggestions.map((s) => (
          <div
            key={s.id}
            className="space-y-3 rounded-2xl border border-ink-950/10 bg-white p-5"
          >
            <div>
              <p className="text-sm font-medium text-ink-950">{s.representative_question}</p>
              <p className="text-xs text-ink-950/40">
                Asked {s.occurrence_count} time{s.occurrence_count === 1 ? "" : "s"} with no
                answer
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-950/60">
                Draft answer (edit before approving if needed)
              </label>
              <textarea
                value={drafts[s.id] ?? ""}
                onChange={(e) =>
                  setDrafts((prev) => ({ ...prev, [s.id]: e.target.value }))
                }
                rows={5}
                className="w-full rounded-xl border border-ink-950/10 px-3 py-2 text-sm outline-none focus:border-brand"
              />
            </div>

            {errorById[s.id] && <p className="text-xs text-red-600">{errorById[s.id]}</p>}

            <div className="flex gap-2">
              <button
                onClick={() => handleApprove(s.id)}
                disabled={busyId === s.id}
                className="rounded-xl bg-brand px-4 py-2 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                {busyId === s.id ? "Working…" : "Approve"}
              </button>
              <button
                onClick={() => handleReject(s.id)}
                disabled={busyId === s.id}
                className="rounded-xl border border-ink-950/10 px-4 py-2 text-xs font-medium text-ink-950/70 transition hover:text-red-600 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
