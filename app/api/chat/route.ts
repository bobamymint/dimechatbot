import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText, streamChat, type ChatTurn } from "@/lib/gemini";
import { streamChatGroq, isGroqConfigured } from "@/lib/groq";
import { siteConfig } from "@/lib/config";

export const runtime = "nodejs";

interface ChatRequestBody {
  messages: ChatTurn[];
}

function buildSystemPrompt(context: string): string {
  return `You are the ${siteConfig.name} assistant. You answer questions using ONLY the "Knowledge" section below.

Rules:
- Answer using only facts contained in the Knowledge section.
- If the Knowledge section does not contain the answer, say clearly that you don't have that information — do not guess, speculate, or use outside knowledge.
- Be concise and friendly. Prefer short paragraphs over long lists.
- Never invent facts, numbers, prices, or policies that are not in the Knowledge section.

Knowledge:
"""
${context || "(no relevant knowledge found for this question)"}
"""`;
}

// Phrases that show up when the model is telling the user it doesn't have
// the information (per the system prompt rule above). Used as a
// best-effort heuristic to flag whether a question was actually answered,
// vs. just "context was found but didn't actually contain the answer".
// Not 100% precise — the model's exact wording can vary — but it catches
// the overwhelming majority of "I don't know" style replies in both
// Thai and English.
const NO_INFO_PATTERNS = [
  "ไม่มีข้อมูล",
  "ไม่พบข้อมูล",
  "ยังไม่มีข้อมูล",
  "ไม่ทราบข้อมูล",
  "don't have that information",
  "don't have information",
  "do not have information",
  "no information about",
  "i don't have",
  "i do not have",
];

function looksAnswered(fullText: string): boolean {
  const lower = fullText.toLowerCase();
  return !NO_INFO_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

// Fire-and-forget: reads the tee'd log branch of the stream to accumulate
// the full answer text, then writes it (plus the "answered" heuristic)
// into the chat_logs row we created before streaming started. Never
// throws into the main request path.
async function logAnswerWhenDone(
  supabase: ReturnType<typeof createAdminClient>,
  logId: string | undefined,
  logStream: ReadableStream<Uint8Array>
) {
  if (!logId) return;
  try {
    const reader = logStream.getReader();
    const decoder = new TextDecoder();
    let full = "";
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
    }
    await supabase
      .from("chat_logs")
      .update({ answer: full, answered: looksAnswered(full) })
      .eq("id", logId);
  } catch (e) {
    console.error("chat log answer capture failed", e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ChatRequestBody;
    const messages = body.messages || [];
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");

    if (!lastUserMessage) {
      return new Response("No user message provided", { status: 400 });
    }

    const supabase = createAdminClient();

    // 1. Embed the user's latest question.
    const queryEmbedding = await embedText(lastUserMessage.content, "RETRIEVAL_QUERY");

    // 2. Retrieve the most relevant knowledge chunks via pgvector.
    const { data: matches, error } = await supabase.rpc("match_document_chunks", {
      query_embedding: queryEmbedding,
      match_count: 6,
      similarity_threshold: 0.5,
    });

    if (error) {
      console.error("match_document_chunks error", error);
    }

    const matchList = (matches || []) as { content: string; similarity: number }[];
    const hasKnowledge = matchList.length > 0;
    const topSimilarity = hasKnowledge ? matchList[0].similarity : null;
    const context = matchList.map((m) => m.content).join("\n\n---\n\n");

    // 2b. Log the question immediately, flagged by whether we found
    // relevant knowledge chunks (has_knowledge — a search-side signal).
    // The "answered" flag (whether the final reply actually contained
    // an answer, vs. an "I don't know") is filled in once streaming
    // finishes — see logAnswerWhenDone. This insert is best-effort and
    // never blocks or fails the actual chat response.
    let logId: string | undefined;
    try {
      const { data: logRow, error: logError } = await supabase
        .from("chat_logs")
        .insert({
          question: lastUserMessage.content,
          has_knowledge: hasKnowledge,
          top_similarity: topSimilarity,
        })
        .select("id")
        .single();
      if (logError) {
        console.error("chat_logs insert error", logError);
      } else {
        logId = logRow?.id;
      }
    } catch (logErr) {
      console.error("chat_logs insert failed", logErr);
    }

    // 3. Stream the answer back, grounded strictly in that context.
    // Prefer Groq (much higher free-tier request volume) when configured,
    // and fall back to Gemini if Groq isn't set up or its *initial*
    // connection fails (e.g. Groq's own rate limit, bad key, network
    // issue). This fallback only works because it's gated on the initial
    // fetch inside streamChatGroq, before any Response/stream has been
    // returned — once headers are sent to the client there's no way to
    // swap providers mid-stream.
    const systemPrompt = buildSystemPrompt(context);
    const recentHistory = messages.slice(-10);
    let stream: ReadableStream<Uint8Array>;

    if (isGroqConfigured()) {
      try {
        stream = await streamChatGroq(systemPrompt, recentHistory);
      } catch (groqErr) {
        console.error("Groq failed, falling back to Gemini", groqErr);
        stream = await streamChat(systemPrompt, recentHistory);
      }
    } else {
      stream = await streamChat(systemPrompt, recentHistory);
    }

    // Split the stream: one branch goes to the client as before, the
    // other is consumed in the background to capture the full answer
    // text for chat_logs, without delaying or altering the response.
    const [clientStream, logStream] = stream.tee();
    void logAnswerWhenDone(supabase, logId, logStream);

    return new Response(clientStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (err) {
    console.error("chat route error", err);

    const message = err instanceof Error ? err.message : String(err);
    const isRateLimited = /\(429\)|RESOURCE_EXHAUSTED/.test(message);

    if (isRateLimited) {
      return new Response(
        "I'm getting a lot of questions right now and hit the free plan's usage limit. Please wait about a minute and try again.",
        { status: 429 }
      );
    }

    return new Response("Something went wrong answering that question.", {
      status: 500,
    });
  }
}
