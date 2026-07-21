// Thin wrapper around Groq's OpenAI-compatible chat completions API. Groq
// is used as the primary (much higher free-tier throughput) chat provider
// when GROQ_API_KEY is set; lib/gemini.ts's streamChat remains as the
// fallback so the app keeps working even if Groq isn't configured or hits
// its own rate limit. Gemini is still used for embeddings/retrieval
// either way — Groq doesn't offer an embeddings endpoint.

import type { ChatTurn } from "./gemini";

const API_BASE = "https://api.groq.com/openai/v1";

export function isGroqConfigured(): boolean {
  return Boolean(process.env.GROQ_API_KEY);
}

function apiKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  return key;
}

function chatModel() {
  // llama-3.1-8b-instant has the highest free-tier daily request quota on
  // Groq (built for exactly this kind of high-volume, straightforward
  // Q&A workload). For noticeably stronger reasoning at a much lower
  // daily cap, set GROQ_CHAT_MODEL=llama-3.3-70b-versatile instead.
  return process.env.GROQ_CHAT_MODEL || "llama-3.1-8b-instant";
}

// The free tier also has a fairly tight tokens-per-minute cap (6000 TPM for
// llama-3.1-8b-instant), separate from the daily request cap. That's easy
// to brush up against briefly under bursty traffic even though the daily
// quota has tons of headroom left. Groq's 429 body tells us how long to
// wait ("Please try again in 13.78s"), so parse that out and do a single
// short retry instead of immediately giving up and falling back to Gemini
// (which typically has much less daily headroom to spare).
function parseRetryDelayMs(errBody: string): number {
  const match = errBody.match(/try again in ([\d.]+)s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    if (!Number.isNaN(seconds)) return Math.min(Math.ceil(seconds * 1000) + 250, 15000);
  }
  return 4000;
}

async function fetchGroqWithRetry(body: string): Promise<Response> {
  const doFetch = () =>
    fetch(`${API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body,
    });

  const res = await doFetch();
  if (res.status !== 429) return res;

  const errBody = await res.text().catch(() => "");
  const delayMs = parseRetryDelayMs(errBody);
  console.error(`Groq 429, retrying in ${delayMs}ms`, errBody.slice(0, 500));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return doFetch();
}

/**
 * Stream a chat completion from Groq given a system prompt and prior
 * conversation turns. Mirrors lib/gemini.ts's streamChat so the two are
 * interchangeable from the caller's point of view: returns a
 * ReadableStream of plain text chunks suitable for piping into a Response.
 */
export async function streamChatGroq(
  systemPrompt: string,
  history: ChatTurn[]
): Promise<ReadableStream<Uint8Array>> {
  // Keep only the last few turns and a moderate max_tokens to stay well
  // under the 6000 TPM free-tier ceiling — a long history plus a large
  // RAG-injected system prompt can otherwise burn through most of a
  // minute's budget in a single request.
  const trimmedHistory = history.slice(-6);

  const res = await fetchGroqWithRetry(
    JSON.stringify({
      model: chatModel(),
      stream: true,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        ...trimmedHistory.map((turn) => ({
          role: turn.role === "model" ? "assistant" : "user",
          content: turn.content,
        })),
      ],
    })
  );

  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Groq chat completions failed (${res.status}): ${errBody}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let emittedAny = false;
      let framesSeen = 0;

      function processLine(rawLine: string) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) return;
        const jsonStr = line.slice("data:".length).trim();
        if (!jsonStr || jsonStr === "[DONE]") return;
        framesSeen++;
        try {
          const parsed = JSON.parse(jsonStr);
          const content = parsed?.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content.length > 0) {
            emittedAny = true;
            controller.enqueue(encoder.encode(content));
          }
        } catch (parseErr) {
          console.error("Groq SSE frame parse error", parseErr, jsonStr.slice(0, 1000));
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) processLine(line);
          }

          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) processLine(buffer);
            break;
          }
        }
        // Successful completion — log at info level so it doesn't show up
        // as a red error in Vercel's logs. Genuine problems (parse errors,
        // empty responses) are still logged via console.error elsewhere.
        console.log(`Groq stream done. framesSeen=${framesSeen} emittedAny=${emittedAny}`);
      } catch (err) {
        console.error("Groq stream read error", err);
        controller.error(err);
        return;
      }

      if (!emittedAny) {
        // By this point the Response has already been sent to the client
        // (headers went out as soon as route.ts got a stream back from
        // streamChatGroq), so there's no swapping to Gemini here — the
        // fallback-to-Gemini logic in route.ts only covers failures on
        // the *initial* connection, before any bytes are sent. This is
        // just a last-resort safety net so the UI never hangs silently.
        console.error("Groq stream closed with no text at all");
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
