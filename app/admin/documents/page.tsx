"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { siteConfig } from "@/lib/config";

interface DocumentRow {
  id: string;
  title: string;
  filename: string;
  status: "processing" | "ready" | "failed";
  error: string | null;
  created_at: string;
  chunkCount: number;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [consolidating, setConsolidating] = useState(false);
  const [consolidateMessage, setConsolidateMessage] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/documents");
    if (res.ok) {
      const data = await res.json();
      setDocuments(data.documents);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadError(null);

    const formData = new FormData();
    formData.append("file", file);
    if (titleInputRef.current?.value) {
      formData.append("title", titleInputRef.current.value);
    }

    const res = await fetch("/api/admin/upload", { method: "POST", body: formData });

    setUploading(false);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setUploadError(data.error || "Upload failed");
      return;
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
    if (titleInputRef.current) titleInputRef.current.value = "";
    loadDocuments();
  }

  async function handleDelete(id: string) {
    if (!confirm("Remove this document from the knowledge base?")) return;
    await fetch(`/api/admin/documents/${id}`, { method: "DELETE" });
    loadDocuments();
  }

  // Merges every individually-approved suggestion (each one its own
  // small [Suggested] document — see approve/route.ts) into a single
  // combined FAQ document, to keep this list from growing one row per
  // approved question. Safe to run any time; does nothing if there's
  // fewer than 2 to merge.
  async function handleConsolidate() {
    if (
      !confirm(
        "Merge all individually-approved suggestions into one combined FAQ document? The small originals will be deleted (their content is preserved in the merged document)."
      )
    )
      return;

    setConsolidating(true);
    setConsolidateMessage(null);

    const res = await fetch("/api/admin/documents/consolidate", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setConsolidating(false);

    if (!res.ok) {
      setConsolidateMessage(data.error || "Consolidate failed");
      return;
    }

    setConsolidateMessage(
      data.merged > 0
        ? `Merged ${data.merged} suggestion${data.merged === 1 ? "" : "s"} into one document.`
        : data.message || "Nothing to consolidate."
    );
    loadDocuments();
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/admin/login");
    router.refresh();
  }

  // Opens the inline editor for a document, loading its current full
  // text (chunks joined back together) to edit. Works the same for a
  // single approved suggestion or a merged multi-question FAQ document
  // — for a merged one, find the Q&A block to update inside the text.
  async function handleStartEdit(id: string) {
    setEditingId(id);
    setEditText("");
    setEditError(null);
    setEditLoading(true);

    const res = await fetch(`/api/admin/documents/${id}`);
    const data = await res.json().catch(() => ({}));
    setEditLoading(false);

    if (!res.ok) {
      setEditError(data.error || "Failed to load document text");
      return;
    }
    setEditText(data.text || "");
  }

  function handleCancelEdit() {
    setEditingId(null);
    setEditText("");
    setEditError(null);
  }

  async function handleSaveEdit(id: string) {
    setEditSaving(true);
    setEditError(null);

    const res = await fetch(`/api/admin/documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: editText }),
    });
    const data = await res.json().catch(() => ({}));
    setEditSaving(false);

    if (!res.ok) {
      setEditError(data.error || "Save failed");
      return;
    }

    setEditingId(null);
    setEditText("");
    loadDocuments();
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-ink-950">
            {siteConfig.name} — Knowledge base
          </h1>
          <p className="text-xs text-ink-950/50">
            Upload documents here to teach the chatbot new information.
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
        <span className="text-brand">Documents</span>
        <Link href="/admin/suggestions" className="text-ink-950/50 hover:text-ink-950">
          Suggestions
        </Link>
      </nav>

      <form
        onSubmit={handleUpload}
        className="mb-8 space-y-3 rounded-2xl border border-ink-950/10 bg-white p-5"
      >
        <h2 className="text-sm font-medium text-ink-950">Add a document</h2>
        <input
          ref={titleInputRef}
          type="text"
          placeholder="Title (optional — defaults to file name)"
          className="w-full rounded-xl border border-ink-950/10 px-3 py-2 text-sm outline-none focus:border-brand"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.docx,.txt,.md"
          required
          className="w-full text-sm"
        />
        <p className="text-xs text-ink-950/40">Supported: PDF, DOCX, TXT, MD</p>
        {uploadError && <p className="text-xs text-red-600">{uploadError}</p>}
        <button
          type="submit"
          disabled={uploading}
          className="rounded-xl bg-brand px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
        >
          {uploading ? "Processing…" : "Upload"}
        </button>
      </form>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink-950">Documents</h2>
          <button
            onClick={handleConsolidate}
            disabled={consolidating}
            className="text-xs font-medium text-ink-950/50 hover:text-ink-950 disabled:opacity-50"
          >
            {consolidating ? "Merging…" : "Merge suggestion documents"}
          </button>
        </div>
        {consolidateMessage && (
          <p className="text-xs text-ink-950/50">{consolidateMessage}</p>
        )}
        {loading && <p className="text-sm text-ink-950/40">Loading…</p>}
        {!loading && documents.length === 0 && (
          <p className="text-sm text-ink-950/40">No documents uploaded yet.</p>
        )}
        {documents.map((doc) => (
          <div
            key={doc.id}
            className="rounded-xl border border-ink-950/10 bg-white px-4 py-3"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink-950">{doc.title}</p>
                <p className="text-xs text-ink-950/40">
                  {doc.filename} · {doc.chunkCount} chunk{doc.chunkCount === 1 ? "" : "s"} ·{" "}
                  <StatusLabel status={doc.status} />
                  {doc.status === "failed" && doc.error ? ` — ${doc.error}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-3">
                {editingId === doc.id ? (
                  <button
                    onClick={handleCancelEdit}
                    className="text-xs font-medium text-ink-950/50 hover:text-ink-950"
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    onClick={() => handleStartEdit(doc.id)}
                    className="text-xs font-medium text-ink-950/50 hover:text-ink-950"
                  >
                    Edit
                  </button>
                )}
                <button
                  onClick={() => handleDelete(doc.id)}
                  className="text-xs font-medium text-red-600 hover:text-red-700"
                >
                  Delete
                </button>
              </div>
            </div>

            {editingId === doc.id && (
              <div className="mt-3 space-y-2 border-t border-ink-950/10 pt-3">
                {editLoading && <p className="text-xs text-ink-950/40">Loading text…</p>}
                {!editLoading && (
                  <textarea
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={10}
                    className="w-full rounded-xl border border-ink-950/10 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                )}
                {editError && <p className="text-xs text-red-600">{editError}</p>}
                <div className="flex gap-2">
                  <button
                    onClick={() => handleSaveEdit(doc.id)}
                    disabled={editLoading || editSaving}
                    className="rounded-xl bg-brand px-4 py-2 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    {editSaving ? "Saving…" : "Save"}
                  </button>
                  <button
                    onClick={handleCancelEdit}
                    className="rounded-xl border border-ink-950/10 px-4 py-2 text-xs font-medium text-ink-950/70 hover:text-ink-950"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusLabel({ status }: { status: DocumentRow["status"] }) {
  const color =
    status === "ready"
      ? "text-emerald-600"
      : status === "failed"
      ? "text-red-600"
      : "text-accent-600";
  return <span className={color}>{status}</span>;
}
