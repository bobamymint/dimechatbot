// Thin wrapper around Cerebras's OpenAI-compatible chat completions API.
// Used as a THIRD fallback chat provider — after Groq (primary) and
// Gemini (second fallback) — for the rare case both of those are
// unavailable at once (e.g. simultaneous rate limits, as has happened
// during heavy testing). Mirrors lib/groq.ts's shape closely so it's a
// drop-in alternative from route.ts's point of view.
//
// Note: Cerebras's free-tier model catalog changes fairly often (models
// get added/removed with little notice), so CEREBRAS_CHAT_MODEL is
// configurable via env var rather than hardcoded, and this should be
// treated as a backup layer, not a primary provider to depend on.

import type { ChatTurn } from "./gemini";

const API_BASE = "https://api.cerebras.ai/v1";

export function isCerebrasConfigured(): boolean {
  return Boolean(process.env.CEREBRAS_API_KEY);
}

function apiKey() {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) throw new Error("CEREBRAS_API_KEY is not set");
  return key;
}

function chatModel() {
  // llama-3.3-70b is a safe, commonly-available default; check Cerebras's
  // current free model list at cloud.cerebras.ai if this stops working —
  // their free catalog rotates more than Groq's does.
  return process.env.CEREBRAS_CHAT_MODEL || "llama-3.3-70b";
}

async function fetchCerebras(body: string): Promise<Response> {
  return fetch(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body,
  });
}

/**
 * Stream a chat completion from Cerebras given a system prompt and prior
 * conversation turns. Mirrors lib/groq.ts's streamChatGroq and
 * lib/gemini.ts's streamChat so all three are interchangeable from the
 * caller's point of view: returns a ReadableStream of plain text chunks
 * suitable for piping into a Response.
 */
export async function streamChatCerebras(
  systemPrompt: string,
  history: ChatTurn[]
): Promise<ReadableStream<Uint8Array>> {
  const trimmedHistory = history.slice(-6);

  const res = await fetchCerebras(
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
    throw new Error(`Cerebras chat completions failed (${res.status}): ${errBody}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      let emittedAny = false;

      function processLine(rawLine: string) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) return;
        const jsonStr = line.slice("data:".length).trim();
        if (!jsonStr || jsonStr === "[DONE]") return;
        try {
          const parsed = JSON.parse(jsonStr);
          const content = parsed?.choices?.[0]?.delta?.content;
          if (typeof content === "string" && content.length > 0) {
            emittedAny = true;
            controller.enqueue(encoder.encode(content));
          }
        } catch (parseErr) {
          console.error("Cerebras SSE frame parse error", parseErr, jsonStr.slice(0, 1000));
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
        console.log(`Cerebras stream done. emittedAny=${emittedAny}`);
      } catch (err) {
        console.error("Cerebras stream read error", err);
        controller.error(err);
        return;
      }

      if (!emittedAny) {
        console.error("Cerebras stream closed with no text at all");
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
