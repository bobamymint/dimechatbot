// Thin wrapper around the Google Gemini REST API. We call the REST API
// directly with fetch (rather than pulling in the full SDK) to keep the
// dependency footprint small and make streaming straightforward on
// Vercel's Node.js runtime.

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBEDDING_DIMENSIONS = 768;

function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

function chatModel() {
  // gemini-2.5-flash-lite has a much higher free-tier quota than
  // gemini-2.5-flash (roughly 4x the daily requests, 3x per-minute) for
  // essentially the same quality on a straightforward "answer from
  // retrieved knowledge" chatbot like this one, so it's the better free
  // default. Override with GEMINI_CHAT_MODEL if you want something else.
  return process.env.GEMINI_CHAT_MODEL || "gemini-2.5-flash-lite";
}

function embeddingModel() {
  return process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";
}

/** Embed a single piece of text into a fixed-size vector for storage/search. */
export async function embedText(
  text: string,
  taskType: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY" = "RETRIEVAL_DOCUMENT"
): Promise<number[]> {
  const res = await fetchWithRetry(
    `${API_BASE}/models/${embeddingModel()}:embedContent?key=${apiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType,
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Gemini embedContent failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  return data.embedding.values as number[];
}

/** Embed many chunks, sequentially, to stay comfortably within free-tier rate limits. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embedText(text, "RETRIEVAL_DOCUMENT"));
  }
  return results;
}

export interface ChatTurn {
  role: "user" | "model";
  content: string;
}

/**
 * Fetch, but if Gemini responds with 429 (rate limited), wait briefly and
 * retry once. This smooths over short-lived per-minute rate-limit blips on
 * the free tier without making the user see an error. It intentionally
 * does NOT wait long (Vercel functions have a limited execution window) —
 * if the daily quota is exhausted rather than a momentary minute-limit,
 * this retry will still fail and the caller surfaces a clear message.
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 429) return res;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return fetch(url, init);
}

/**
 * Stream a chat completion from Gemini given a system prompt (the
 * "only answer from this knowledge" instructions + retrieved context)
 * and prior conversation turns. Returns a ReadableStream of plain text
 * chunks suitable for piping straight into a Response.
 */
export async function streamChat(
  systemPrompt: string,
  history: ChatTurn[]
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetchWithRetry(
    `${API_BASE}/models/${chatModel()}:streamGenerateContent?alt=sse&key=${apiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: history.map((turn) => ({
          role: turn.role,
          parts: [{ text: turn.content }],
        })),
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 2048,
          // Gemini 2.5 models "think" before answering by default, and
          // those thinking tokens are drawn from the same maxOutputTokens
          // budget. Without this, the model can burn the entire budget on
          // internal reasoning and return a 200 response with zero visible
          // answer text. Disabling it guarantees the budget goes to the
          // actual answer.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini streamGenerateContent failed (${res.status}): ${errBody}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let emittedAny = false;
      let lastFinishReason: string | undefined;
      let framesSeen = 0;

      function processLine(rawLine: string) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) return;
        const jsonStr = line.slice("data:".length).trim();
        if (!jsonStr) return;
        framesSeen++;
        try {
          const parsed = JSON.parse(jsonStr);

          if (parsed?.promptFeedback) {
            console.error("Gemini promptFeedback", JSON.stringify(parsed.promptFeedback));
          }

          const candidate = parsed?.candidates?.[0];
          if (!candidate) {
            // No candidate at all in this frame (e.g. blocked prompt,
            // or an unexpected payload shape) — log the raw frame so
            // we can see exactly what Gemini sent back.
            console.error("Gemini frame with no candidate:", jsonStr.slice(0, 1000));
          }
          if (candidate?.finishReason) lastFinishReason = candidate.finishReason;

          const parts = candidate?.content?.parts;
          if (Array.isArray(parts)) {
            if (parts.length === 0) {
              console.error(
                "Gemini candidate has empty parts array",
                JSON.stringify(candidate).slice(0, 1000)
              );
            }
            for (const part of parts) {
              if (typeof part?.text === "string" && part.text.length > 0) {
                emittedAny = true;
                controller.enqueue(encoder.encode(part.text));
              }
            }
          } else if (candidate) {
            console.error(
              "Gemini candidate has no parts array",
              JSON.stringify(candidate).slice(0, 1000)
            );
          }
        } catch (parseErr) {
          console.error("Gemini SSE frame parse error", parseErr, jsonStr.slice(0, 1000));
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (value) {
            buffer += decoder.decode(value, { stream: true });
            // Each "data: {...}" event is a complete, self-contained JSON
            // object on its own line. Google doesn't reliably separate
            // consecutive events with a full blank line, so we parse
            // line-by-line rather than relying on a "\n\n" delimiter.
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) processLine(line);
          }

          if (done) {
            // Flush whatever's left in the buffer — the final line may not
            // end with a newline, and discarding it here was silently
            // dropping the actual answer.
            buffer += decoder.decode();
            if (buffer.trim()) processLine(buffer);
            break;
          }
        }
        // Successful completion — log at info level so it doesn't show up
        // as a red error in Vercel's logs. Genuine problems (parse errors,
        // missing candidates, empty responses) are still logged via
        // console.error above/below so they're easy to spot.
        console.log(`Gemini stream done. framesSeen=${framesSeen} emittedAny=${emittedAny}`);
      } catch (err) {
        console.error("Gemini stream read error", err);
        if (!emittedAny) {
          controller.enqueue(
            encoder.encode(
              "Sorry, I ran into a problem generating a response. Please try again."
            )
          );
        }
        controller.close();
        return;
      }

      if (!emittedAny) {
        console.error(
          `Gemini stream closed with no text. finishReason=${lastFinishReason ?? "unknown"}`
        );
        controller.enqueue(
          encoder.encode(
            "Sorry, I couldn't generate a response just now. Please try again in a moment."
          )
        );
      }

      controller.close();
    },
  });
}
