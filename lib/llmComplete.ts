// Non-streaming "ask the model one question, get one string back" helper.
// The customer-facing chat (lib/groq.ts / lib/gemini.ts) needs streaming
// so answers appear token-by-token in the UI; the suggestion drafter
// (lib/draftAnswer.ts) runs in the background on a cron job and just
// needs a plain string, so it's kept separate and simpler. Same provider
// order as the live chat (Groq first if configured, Gemini fallback) so
// behaviour stays consistent between the two.

import { isGroqConfigured } from "./groq";

const GROQ_API_BASE = "https://api.groq.com/openai/v1";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function groqApiKey() {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set");
  return key;
}

function groqChatModel() {
  return process.env.GROQ_CHAT_MODEL || "llama-3.1-8b-instant";
}

function geminiApiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

function geminiChatModel() {
  return process.env.GEMINI_CHAT_MODEL || "gemini-3.5-flash";
}

async function completeWithGroq(prompt: string): Promise<string> {
  const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${groqApiKey()}`,
    },
    body: JSON.stringify({
      model: groqChatModel(),
      stream: false,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Groq chat completions failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Groq returned an empty completion");
  }
  return text.trim();
}

async function completeWithGemini(prompt: string): Promise<string> {
  const res = await fetch(
    `${GEMINI_API_BASE}/models/${geminiChatModel()}:generateContent?key=${geminiApiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
          // See lib/gemini.ts's streamChat for why this matters: without
          // it, "thinking" tokens can eat the whole output budget and
          // leave zero visible text in the response.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini generateContent failed (${res.status}): ${errBody}`);
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p: { text?: string }) => p.text || "").join("")
    : "";
  if (!text.trim()) {
    throw new Error("Gemini returned an empty completion");
  }
  return text.trim();
}

/**
 * Ask the model a single, non-streaming question and get one string back.
 * Tries Groq first (if configured), falls back to Gemini.
 */
export async function complete(prompt: string): Promise<string> {
  if (isGroqConfigured()) {
    try {
      return await completeWithGroq(prompt);
    } catch (err) {
      console.error("Groq completion failed, falling back to Gemini", err);
    }
  }
  return completeWithGemini(prompt);
}
