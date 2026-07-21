// Extracts plain text from an uploaded file's raw bytes based on its
// extension. Keep this on the Node.js runtime (not edge) since pdf-parse
// and mammoth both need Node APIs.

export async function extractText(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop();

  switch (ext) {
    case "pdf": {
      const pdfParse = (await import("pdf-parse")).default;
      const result = await pdfParse(buffer);
      return result.text;
    }
    case "docx": {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case "txt":
    case "md": {
      return buffer.toString("utf-8");
    }
    default:
      throw new Error(
        `Unsupported file type ".${ext}". Please upload a PDF, DOCX, TXT, or MD file.`
      );
  }
}
