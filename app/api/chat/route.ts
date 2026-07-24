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
  return `You are the ${siteConfig.name} assistant. Answer ONLY from the Knowledge section below — never outside knowledge, never invented facts, numbers, or policies.

Rules:
- Match detail to the question. Simple, single-scenario questions get a short direct answer — don't explain internal mechanisms unprompted. Questions involving a real decision or multiple steps (foreign currency, insufficient balance, cross-border) get the full relevant detail immediately, no follow-up needed.
- A chunk sharing keywords with the question (e.g. both mention "บัตร" or "เงื่อนไข") is NOT enough to use it — check that it actually addresses the SAME sub-topic the question asks about (e.g. "conditions to apply for a card" vs "conditions while using a card" vs "card cancellation after inactivity" are different sub-topics even though all three might mention "เงื่อนไข" and "บัตร"). If the closest chunk is only superficially related, treat it as not having the answer.
- Never assume a feature/service exists from a merely similar or related mention — only confirm if explicitly stated.
- For a specific multi-condition scenario, don't chain separate rules/chunks into a novel answer unless that exact combination is explicitly covered. Exception: for analytical/comparative questions ("which is cheapest/best"), you MAY reason over multiple facts that ARE explicitly stated (e.g. comparing stated fees) — just don't invent a missing number or mechanic.
- If Knowledge doesn't answer it, reply MUST start with the exact text ${NO_INFO_MARKER} (no space after), then a brief explanation in the question's language that you don't have that info. If Knowledge DOES answer it, never include that marker.
- Use short lists for sequences/multiple rules; prose for single facts.
- Use recent conversation history to resolve short follow-ups ("which one first?").

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

  const latest = recentUserMessages[recentUserMessages.length - 1] || "";
  const priorContext = recentUserMessages.slice(0, -1);

  // Include the latest question twice (start and end) so it dominates the
  // embedded text even when prior questions in the session were about a
  // completely different topic (e.g. user asks about JPY funding, then
  // switches to asking about gas station payments). Without this, a topic
  // switch mid-conversation can get its retrieval "pulled" toward the old
  // topic and miss the chunk that actually answers the new question.
  // Genuine follow-ups (short questions that truly depend on prior
  // context, e.g. "which one first?") still benefit from priorContext
  // being present at all.
  return [latest, ...priorContext, latest].filter(Boolean).join("\n");
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
      match_count: 5,
      similarity_threshold: 0.45,
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
    const recentHistory = messages.slice(-6);
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
