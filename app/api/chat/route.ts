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

    const context = (matches || [])
      .map((m: { content: string }) => m.content)
      .join("\n\n---\n\n");

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

    return new Response(stream, {
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
