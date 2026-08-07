import { NextRequest, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { embedText, streamChat, type ChatTurn } from "@/lib/gemini";
import { streamChatGroq, isGroqConfigured } from "@/lib/groq";
import { siteConfig } from "@/lib/config";

export const runtime = "nodejs";
// Vercel's Hobby (free) plan defaults to a 10-second function timeout —
// too short when Groq's own retry-after-rate-limit logic (in lib/groq.ts)
// waits up to 15s before even starting to stream a response. Without
// this, Vercel kills the request mid-retry and the user sees a 500 error
// even though Groq would have answered successfully a few seconds later.
// 60s is the maximum allowed on Hobby without enabling Fluid Compute.
export const maxDuration = 60;

interface ChatRequestBody {
  messages: ChatTurn[];
}

// The model is instructed to prepend this exact marker when it has no
// relevant knowledge to answer from. We strip it out of everything the
// user sees (both the live stream and the stored answer text), and use
// its presence as the primary, reliable signal for the `answered` flag
// in chat_logs — far more accurate than guessing from wording alone.
const NO_INFO_MARKER = "[[NO_INFO]]";

function buildSystemPrompt(context: string): string {
  return `You are an internal reference tool for Dime! Customer Care (CC) staff — not customer-facing. Answer ONLY from Knowledge below — no outside knowledge, no invented facts/numbers/policies, no assumptions about what "cards like this usually have."

Rules:
- Never say "ติดต่อ Dime! Customer Support" — the reader IS support. Give the concrete answer directly and completely, no follow-up needed. If truly no info and it's a troubleshooting-style question, give the general checklist ending in escalation to "หน่วยงานที่เกี่ยวข้อง" (or the closest named function) — never a bare "no info" for troubleshooting.
- Never parrot vague hedges ("ตามที่ธนาคารกำหนด") — state the actual concrete number/order/step from Knowledge instead.
- If Knowledge doesn't mention a specific named feature (e.g. Apple Pay) at all, treat it as unknown — never answer yes/no from general debit-card knowledge, even if confident.
- Match detail to complexity: simple questions get short answers; multi-step/troubleshooting cases get full detail immediately, unprompted.
- For time/hours, limit/ceiling, or fee/waiver questions, prefer the consolidated R1/R2/R3 reference tables over scattered mentions elsewhere; if the sub-type isn't specified, answer all relevant sub-types rather than picking one or saying no info. Never flatly deny that any waiver/exemption exists (e.g. "ไม่มีนโยบายยกเว้น") without first checking R3 for specific exemption cases that may apply.
- Never cite ANY internal document label or ID — this includes legal clause numbers ("ข้อ 6.3"), FAQ numbering ("Q12"), troubleshooting item labels ("C8"), or reference-table labels ("R1", "R2"), or any other letter+number code used to organize this Knowledge. These labels exist only to organize the document for editing — the customer/CC reader has no idea what they mean and should never see them. Always translate into plain language instead (e.g. say "ขั้นตอนตรวจสอบ" not "ตามหัวข้อ C8").
- Shared keywords ≠ same topic/procedure (applying vs. using vs. cancelling; paying vs. refund; transfer vs. exchange) — confirm the sub-topic matches before using a chunk, and never blend sentences from chunks describing different procedures.
- Never reuse one named group's answer for a different group by swapping just the name (e.g. don't answer a Thai-citizen question with the foreigner answer with "ชาวต่างชาติ" swapped for "คนไทย") — find and use that group's own actual rule.
- If a customer names a specific merchant/situation for a failed transaction, treat it like the general "specific merchant" troubleshooting case — don't require that exact name to appear in Knowledge.
- Never mention "Knowledge", "context", or "chunk" — answer naturally.
- Never assume a feature exists from a related mention; never chain facts into a new scenario unless that exact combination is explicitly stated (exception: comparing facts that ARE explicitly stated). Explicit prohibitions ("ไม่สามารถ...ได้") always override general permission language elsewhere.
- If Knowledge has nothing on it and it's not a troubleshooting question, start with the exact text ${NO_INFO_MARKER} (no space after) then briefly say, in the question's language, that you don't know — omit the marker if you do know. Don't tack on unrelated-topic advice just because it shares a word.
- Use numbered lists for steps/troubleshooting/multiple rules, prose for single facts; use recent history for short follow-ups.

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
//
// Checks TWO forms: the exact bracketed marker (⟦NO_INFO⟧) the model is
// instructed to use, AND a plain "NO_INFO" fallback (no brackets, with
// optional trailing punctuation/whitespace) in case the model drops the
// bracket characters — this has been observed to happen in practice, and
// without this fallback the raw word leaks straight into the customer's
// chat.
const NO_INFO_FALLBACK_RE = /^NO_INFO[:\-\s]*/i;

function stripLeadingMarker(text: string): { rest: string; found: boolean } {
  if (text.startsWith(NO_INFO_MARKER)) {
    return { rest: text.slice(NO_INFO_MARKER.length), found: true };
  }
  const fallbackMatch = text.match(NO_INFO_FALLBACK_RE);
  if (fallbackMatch) {
    return { rest: text.slice(fallbackMatch[0].length), found: true };
  }
  return { rest: text, found: false };
}

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
          const { rest, found } = stripLeadingMarker(buffer);
          buffer = rest;
          noInfo = found;
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
        const { rest, found } = stripLeadingMarker(buffer);
        buffer = rest;
        noInfo = found;
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

    // Monitoring only (not a fix): the model is instructed never to cite
    // internal clause numbers (e.g. "ข้อ 6.3"), but smaller models don't
    // always follow abstract instructions reliably. This doesn't strip
    // anything from what the user already saw — it just makes violations
    // visible in Vercel's logs so we can tell whether the prompt rule is
    // actually working over time, without needing a user to spot it.
    if (/(?:ตาม)?ข้อ\s*\d+(?:\.\d+){1,3}/.test(full)) {
      console.error("⚠️ Answer leaked an internal clause reference despite the rule:", full);
    }

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
      match_count: 12,
      similarity_threshold: 0.45,
    });

    if (error) {
      console.error("match_document_chunks error", error);
    }

    const matchList = (matches || []) as { content: string; similarity: number }[];
    const hasKnowledge = matchList.length > 0;
    const topSimilarity = hasKnowledge ? matchList[0].similarity : null;
    // Hard safety cap. With a 128-topic knowledge base full of near-duplicate
    // vocabulary ("บัตร", "ค่าธรรมเนียม", "แอป Dime!" everywhere), the top-
    // ranked chunk by similarity is often NOT the one with the actual answer
    // — so match_count alone isn't enough; the cap must be generous enough
    // that most of the 12 retrieved chunks actually survive into context,
    // not just the first ~3. 7500 chars (~1900 tokens) still leaves solid
    // headroom under Groq's 6000 TPM ceiling alongside the system prompt
    // and recent history — see chat history for the token math.
    const MAX_CONTEXT_CHARS = 7500;
    let context = matchList.map((m) => m.content).join("\n\n---\n\n");
    if (context.length > MAX_CONTEXT_CHARS) {
      context = context.slice(0, MAX_CONTEXT_CHARS) + "\n\n(context truncated)";
    }

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
    // Two-tier fallback: Groq (primary, highest free-tier throughput) ->
    // Gemini (second, used for embeddings anyway so always configured).
    // (A third Cerebras tier was tried and removed — its free model
    // catalog proved too unstable for this project to depend on; see
    // git history if reviving it later.) This fallback only works
    // because it's gated on the initial connection attempt of the next
    // provider, before any Response/stream has been returned to the
    // client — once headers are sent there's no way to swap providers
    // mid-stream.
    const systemPrompt = buildSystemPrompt(context);
    const recentHistory = messages.slice(-4);
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
