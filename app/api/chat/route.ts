import { NextRequest, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText, streamChat, type ChatTurn } from "@/lib/gemini";
import { streamChatGroq, isGroqConfigured } from "@/lib/groq";
import { siteConfig } from "@/lib/config";

export const runtime = "nodejs";

interface ChatRequestBody {
  messages: ChatTurn[];
}

// The model is instructed to prepend this exact marker when it has no
// relevant knowledge to answer from. We strip it out of everything the
// user sees (both the live stream and the stored answer text), and use
// its presence as the primary, reliable signal for the `answered` flag
// in chat_logs — far more accurate than guessing from wording alone.
const NO_INFO_MARKER = "\u27E6NO_INFO\u27E7"; // ⟦NO_INFO⟧

function buildSystemPrompt(context: string): string {
  return `You are the ${siteConfig.name} assistant. You answer questions using ONLY the "Knowledge" section below.

Rules:
- Answer using only facts contained in the Knowledge section.
- Match the amount of detail to what the question actually needs — don't pad a simple answer with mechanism explanations the user didn't ask about.
  - If the question has one straightforward answer (e.g. "can I pay for gas with this card?" when the transaction is a normal single-currency domestic payment), just answer directly and briefly. Do NOT explain internal processes (like funding-source priority order, currency conversion logic) unless the question specifically involves a scenario where that detail changes the outcome or the user would need to know it (e.g. multiple currencies, insufficient balance, cross-border payment).
  - If the question DOES involve a scenario with multiple relevant steps or a real decision the user needs to understand (e.g. paying in a foreign currency, what happens if a balance is insufficient), THEN give the complete answer including that detail immediately, without waiting for a follow-up.
  - Rule of thumb: would a knowledgeable human support agent mention this detail unprompted for this specific question? If not, leave it out.
- Do NOT infer that a feature, product, or service exists just because the Knowledge section mentions a *similar* or *related* topic. Only confirm something exists if it is explicitly stated. If a chunk merely mentions a related term (e.g. an interest rate on overdue balances) but does not explicitly confirm the specific feature being asked about (e.g. a loan/cash-advance feature), treat that as NOT having the answer.
- If the Knowledge section does NOT contain the answer, your reply MUST start with the exact text ${NO_INFO_MARKER} (no space after it), immediately followed by a short, friendly explanation — in the same language as the question — that you don't have that information yet. Do not guess, speculate, or use outside knowledge.
- If the Knowledge section DOES contain the answer, do NOT include ${NO_INFO_MARKER} anywhere in your reply.
- Be friendly and clear. Use a short list when the answer involves a sequence, order, or several distinct rules — that is clearer than cramming it into one paragraph. Only avoid lists when the answer is a single simple fact.
- Never invent facts, numbers, prices, or policies that are not in the Knowledge section.
- Use the recent conversation history to understand what a short follow-up question (e.g. "which one first?", "what about that?") is actually referring to.

Knowledge:
"""
${context || "(no relevant knowledge found for this question)"}
"""`;
}

// Fallback keyword check, used only if the model forgets to include the
// marker above. Not the primary signal anymore, just a safety net.
const NO_INFO_FALLBACK_PATTERNS = [
  "ไม่มีข้อมูล",
  "ไม่พบข้อมูล",
  "ยังไม่มีข้อมูล",
  "ไม่ทราบข้อมูล",
  "ไม่ได้ระบุ",
  "ไม่ได้กล่าวถึง",
  "ไม่ปรากฏ",
  "ไม่ได้ให้ข้อมูล",
  "ไม่มีรายละเอียด",
  "ไม่มีการระบุ",
  "don't have that information",
  "don't have information",
  "do not have information",
  "no information about",
  "not specified",
  "not mentioned",
  "not provided",
  "isn't specified",
  "wasn't specified",
  "no details",
  "i don't have",
  "i do not have",
];

function matchesFallbackPattern(text: string): boolean {
  const lower = text.toLowerCase();
  return NO_INFO_FALLBACK_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

// Reads a stream, strips a leading NO_INFO_MARKER if present (buffering
// just enough of the start to check reliably), and reports back both the
// cleaned full text and whether the marker was found. Used identically
// for the client-facing stream (so the marker is never shown) and the
// background logging stream (so we store the clean answer + an accurate
// flag).
function stripMarkerTransform(onDone: (fullText: string, noInfoMarkerFound: boolean) => void) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let checked = false;
  let noInfo = false;
  let full = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      if (!checked) {
        buffer += text;
        if (buffer.length >= NO_INFO_MARKER.length) {
          if (buffer.startsWith(NO_INFO_MARKER)) {
            noInfo = true;
            buffer = buffer.slice(NO_INFO_MARKER.length);
          }
          checked = true;
          full += buffer;
          if (buffer) controller.enqueue(encoder.encode(buffer));
          buffer = "";
        }
        // else: keep buffering until we have enough characters to know
        // for sure whether the marker is there.
      } else {
        full += text;
        controller.enqueue(chunk);
      }
    },
    flush(controller) {
      if (!checked && buffer) {
        if (buffer.startsWith(NO_INFO_MARKER)) {
          noInfo = true;
          buffer = buffer.slice(NO_INFO_MARKER.length);
        }
        full += buffer;
        if (buffer) controller.enqueue(encoder.encode(buffer));
      }
      // Safety net: if the model didn't include the marker but the text
      // still reads like a "don't know" reply, treat it as no-info too.
      const noInfoFinal = noInfo || matchesFallbackPattern(full);
      onDone(full, noInfoFinal);
    },
  });
}

// Fire-and-forget: consumes the log branch of the (marker-stripped)
// stream, then writes the clean answer text + accurate `answered` flag
// + which provider generated it into the chat_logs row created before
// streaming started.
async function logAnswerWhenDone(
  supabase: ReturnType<typeof createAdminClient>,
  logId: string | undefined,
  logStream: ReadableStream<Uint8Array>,
  provider: "groq" | "gemini"
) {
  if (!logId) return;
  try {
    let resolveResult: (v: { full: string; noInfo: boolean }) => void;
    const resultPromise = new Promise<{ full: string; noInfo: boolean }>((resolve) => {
      resolveResult = resolve;
    });
    const transform = stripMarkerTransform((full, noInfo) => resolveResult({ full, noInfo }));
    const cleaned = logStream.pipeThrough(transform);

    // Drain the cleaned stream (we don't need its bytes here, just need
    // to pump it so `flush` above fires and resolves the result).
    const reader = cleaned.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const { full, noInfo } = await resultPromise;
    await supabase
      .from("chat_logs")
      .update({ answer: full, answered: !noInfo, provider })
      .eq("id", logId);
  } catch (e) {
    console.error("chat log answer capture failed", e);
  }
}

// Builds the text used for the knowledge-base search step. Using only
// the latest message causes short follow-up questions ("which one
// first?", "what about that?") to search in isolation and potentially
// retrieve a completely different (and inconsistent) knowledge chunk
// than the one the conversation was actually about. Concatenating the
// last few *user* messages (skipping assistant replies, which would
// just dilute the signal) keeps retrieval anchored to the actual
// running topic without an extra LLM call.
function buildRetrievalQueryText(messages: ChatTurn[]): string {
  const recentUserMessages = messages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content);
  return recentUserMessages.join("\n");
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

    // 1. Embed a context-aware version of the question (last few user
    // turns, not just the latest one) so follow-up questions retrieve
    // knowledge consistent with the ongoing topic.
    const retrievalQueryText = buildRetrievalQueryText(messages);
    const queryEmbedding = await embedText(retrievalQueryText, "RETRIEVAL_QUERY");

    // 2. Retrieve the most relevant knowledge chunks via pgvector.
    const { data: matches, error } = await supabase.rpc("match_document_chunks", {
      query_embedding: queryEmbedding,
      match_count: 8,
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
    // The "answered" flag and "provider" are filled in once streaming
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
    let providerUsed: "groq" | "gemini" = "gemini";

    if (isGroqConfigured()) {
      try {
        stream = await streamChatGroq(systemPrompt, recentHistory);
        providerUsed = "groq";
      } catch (groqErr) {
        console.error("Groq failed, falling back to Gemini", groqErr);
        stream = await streamChat(systemPrompt, recentHistory);
        providerUsed = "gemini";
      }
    } else {
      stream = await streamChat(systemPrompt, recentHistory);
      providerUsed = "gemini";
    }

    // Split the stream: one branch goes to the client (with the marker
    // stripped out so it's never visible), the other is consumed in the
    // background to log the clean answer + accurate answered flag +
    // which provider generated it.
    const [streamForClient, streamForLog] = stream.tee();

    const clientTransform = stripMarkerTransform(() => {});
    const cleanedClientStream = streamForClient.pipeThrough(clientTransform);

    after(() => logAnswerWhenDone(supabase, logId, streamForLog, providerUsed));

    return new Response(cleanedClientStream, {
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
