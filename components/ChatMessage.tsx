import ReactMarkdown from "react-markdown";

export interface Message {
  role: "user" | "model";
  content: string;
}

export function ChatMessage({ role, content }: Message) {
  const isUser = role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[80%] rounded-2xl px-4 py-3 text-[15px] leading-relaxed",
          isUser
            ? "bg-brand text-white rounded-br-sm"
            : "bg-ink-950/[0.04] text-ink-950 rounded-bl-sm",
        ].join(" ")}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{content}</p>
        ) : (
          <div className="space-y-2 [&_a]:underline [&_a]:text-brand [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5">
            <ReactMarkdown>{content || "…"}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
