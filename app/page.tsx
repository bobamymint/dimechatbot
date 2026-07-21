"use client";

import { useEffect, useRef, useState } from "react";
import { ChatMessage, type Message } from "@/components/ChatMessage";
import { ChatInput } from "@/components/ChatInput";
import { siteConfig } from "@/lib/config";

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(text: string) {
    const nextMessages: Message[] = [...messages, { role: "user", content: text }];
    setMessages([...nextMessages, { role: "model", content: "" }]);
    setIsStreaming(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages }),
      });

      if (!res.body) throw new Error("No response body");

      if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "model",
            content: errorText || "Sorry, something went wrong. Please try again.",
          };
          return updated;
        });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "model", content: accumulated };
          return updated;
        });
      }
    } catch (err) {
      console.error(err);
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "model",
          content: "Sorry, something went wrong. Please try again.",
        };
        return updated;
      });
    } finally {
      setIsStreaming(false);
    }
  }

  return (
    <main className="mx-auto flex h-dvh max-w-2xl flex-col px-4">
      <header className="flex items-center gap-3 py-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-semibold text-accent">
          {siteConfig.name.charAt(0)}
        </div>
        <div>
          <h1 className="text-base font-semibold text-ink-950">{siteConfig.name}</h1>
          <p className="text-xs text-ink-950/50">{siteConfig.tagline}</p>
        </div>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto pb-4">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-center">
            <p className="max-w-xs text-sm text-ink-950/40">
              Ask a question and I&apos;ll answer using what I know.
            </p>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessage key={i} role={m.role} content={m.content} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-0 bg-white pb-6 pt-2">
        <ChatInput onSend={handleSend} disabled={isStreaming} />
        <p className="mt-2 text-center text-[11px] text-ink-950/30">
          Answers are limited to {siteConfig.name}&apos;s provided knowledge and may be
          incomplete.
        </p>
      </div>
    </main>
  );
}
