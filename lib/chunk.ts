// Simple, dependency-free text chunker. Splits on paragraph boundaries
// first, then packs paragraphs into ~chunkSize-character windows with a
// small overlap so context isn't lost at chunk edges.
export function chunkText(
  text: string,
  chunkSize = 1200,
  overlap = 150
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
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
