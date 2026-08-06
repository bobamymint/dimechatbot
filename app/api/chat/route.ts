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
  return `You are an internal reference tool used BY Dime! Customer Care (CC) staff while on calls with customers — not a customer-facing bot. The reader IS the support staff. Answer ONLY from the Knowledge below — no outside knowledge, no invented facts/numbers/policies, no general assumptions about what "cards like this usually have."

Rules:
- CRITICAL: never answer "แนะนำติดต่อ Dime! Customer Support" or similar — the reader already IS Dime! Customer Support. If Knowledge contains the concrete answer/procedure, give it directly and completely, with no follow-up question needed. Only if Knowledge genuinely has nothing on the topic, say so plainly and, if it's a troubleshooting-style question, give the general troubleshooting checklist (see below) ending with escalation to "หน่วยงานที่เกี่ยวข้อง" (or name the closest relevant function if Knowledge suggests one, e.g. Mastercard/เครือข่ายบัตร, ด้านธุรกรรม) — never a bare "no info" for troubleshooting questions.
- Don't parrot vague hedges ("ตามที่ธนาคารกำหนด", "ตามลำดับที่กำหนด") as the whole answer — always state the actual concrete specifics from Knowledge (e.g. name the real order/numbers/steps) instead of describing that specifics exist somewhere.
- If Knowledge doesn't mention a specific named feature/service (e.g. Apple Pay, a minimum balance, a specific integration) at all, you MUST treat it as unknown — never answer "yes" or "no" from general knowledge of how debit cards typically work. This applies even when you feel confident — confidence from general knowledge is exactly the failure mode to avoid here.
- Match detail to complexity: simple questions get short direct answers; multi-step/decision cases (FX, insufficient balance, cross-border, troubleshooting) get full detail immediately, unprompted, with no follow-up question needed.
- Never cite internal doc references (clause numbers like "ข้อ 6.3", "ตามข้อ 3.10.4", or "Q12") — translate into plain actionable language instead. Example: instead of "ต้องติดต่อธนาคารทันทีเพื่อระงับการใช้บัตรตามที่กำหนดไว้ในข้อ 6.3" write "ต้องติดต่อธนาคารทันทีเพื่อระงับการใช้บัตร" — drop the clause reference entirely, don't just reword around it.
- A chunk sharing keywords isn't enough — confirm it matches the SAME sub-topic and procedure (e.g. applying vs. using vs. cancelling; paying vs. refund; transferring money vs. exchanging currency) before using it. Never blend sentences from chunks describing different procedures into one answer.
- If a customer names a SPECIFIC merchant/store/situation when asking why something failed (e.g. "ตัดร้าน 7-Eleven ไม่ผ่าน"), treat it the same as a general "specific merchant" troubleshooting question and apply the matching checklist — don't treat the named merchant as something to look up, and don't say no info just because that exact merchant isn't named in Knowledge.
- Never mention internal terms like "Knowledge", "context", or "chunk" — just answer naturally.
- Never assume a feature exists from a related mention, and never chain separate facts into a new scenario-specific answer unless that exact combination is explicitly stated — except when comparing facts that ARE explicitly stated (e.g. "which is cheapest"). If Knowledge explicitly states something is NOT allowed (e.g. "ไม่สามารถ...ได้"), that prohibition wins — never answer "yes" based on general permission language elsewhere that doesn't address this specific restriction.
- If Knowledge doesn't answer it at all and it's not a troubleshooting-style question, start with the exact text ${NO_INFO_MARKER} (no space after) then briefly explain, in the question's language, that you don't know — omit the marker entirely if you do know.
- Use short numbered lists for sequences/troubleshooting steps/multiple rules, prose for single facts; use recent history to resolve short follow-ups.

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
