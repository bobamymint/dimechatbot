// Some source documents (especially FAQ-style PDFs) list many Q&A pairs
// back-to-back with only single line breaks between them — PDF text
// extraction rarely preserves blank-line paragraph breaks the way the
// original document was laid out. Without this, chunkText below sees an
// entire multi-question section as ONE giant "paragraph" (since it only
// splits on blank lines), which then falls into the crude fixed-length
// hard-split path and can slice a question, a table, or an answer in
// half at an arbitrary character offset — silently corrupting exactly
// the kind of content (e.g. a fee/interest-rate table) most likely to be
// asked about directly.
//
// This inserts a blank line before recognizable boundary markers so the
// existing paragraph splitter naturally treats each unit as its own
// atomic block, keeping it together in one chunk whenever it reasonably
// can. Two document styles are covered, since both show up in real
// uploads here:
//   - FAQ-style: "Q12.", "*Q3.", "**Q1.", "หมวด 3 :"
//   - Legal/T&C-style hierarchical clauses: "6.1", "3.10.4", "6.1.1"
function normalizeQaBoundaries(text: string): string {
  return text
    .replace(/(^|\n)\s*(\*{0,2}Q\d+[\.\)])/g, "$1\n\n$2")
    .replace(/(^|\n)\s*(หมวด\s*\d+\s*[:：])/g, "$1\n\n$2")
    .replace(/(^|\n)\s*(\d+(?:\.\d+){1,3}\s+\S)/g, "$1\n\n$2")
    .replace(/\n{3,}/g, "\n\n");
}

// Simple, dependency-free text chunker. Splits on paragraph boundaries
// first, then packs paragraphs into ~chunkSize-character windows with a
// small overlap so context isn't lost at chunk edges.
export function chunkText(
  text: string,
  chunkSize = 1500,
  overlap = 150
): string[] {
  const normalized = normalizeQaBoundaries(text.replace(/\r\n/g, "\n")).trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= chunkSize) {
      current = candidate;
      continue;
    }

    if (current) chunks.push(current);

    if (para.length <= chunkSize) {
      current = para;
    } else {
      // Paragraph itself is too long; hard-split it with overlap.
      let start = 0;
      while (start < para.length) {
        const end = Math.min(start + chunkSize, para.length);
        chunks.push(para.slice(start, end));
        start = end - overlap;
        if (start < 0) start = 0;
        if (end === para.length) break;
      }
      current = "";
    }
  }

  if (current) chunks.push(current);

  return chunks;
}
