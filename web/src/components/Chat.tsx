import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { readableError } from "../lib/api";
import { Markdown } from "./Markdown";

interface Props {
  threadId: string;
  initialMessages: UIMessage[];
  /** Called when a turn finishes, so the sidebar can pick up the new title / ordering. */
  onTurnEnd: () => void;
}

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// The server owns history, so only the newest user message travels. It also guarantees the stored
// text is exactly what the user typed.
const transport = new DefaultChatTransport({
  api: "/api/chat",
  prepareSendMessagesRequest: ({ id, messages }) => {
    const last = messages[messages.length - 1];
    const text = last?.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") ?? "";
    return { body: { threadId: id, message: { text }, timezone } };
  },
});

function textOf(m: UIMessage): string {
  return m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
}

export function Chat({ threadId, initialMessages, onTurnEnd }: Props) {
  const { messages, sendMessage, status, error, clearError } = useChat({
    id: threadId,
    messages: initialMessages,
    transport,
    onFinish: onTurnEnd,
    onError: onTurnEnd, // a failed turn still created a thread and an assistant row
  });
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, status, error]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    clearError();
    void sendMessage({ text });
    setInput("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends, Shift+Enter adds a newline. isComposing keeps IME confirmation from sending.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {messages.length === 0 && (
            <p className="mt-24 text-center text-neutral-500">Ask me anything.</p>
          )}
          {messages.map((m) => {
            const text = textOf(m);
            if (!text) return null;
            return m.role === "user" ? (
              <div key={m.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-neutral-900 px-4 py-2 text-white">
                {text}
              </div>
            ) : (
              <div key={m.id} className="max-w-[95%]">
                <Markdown text={text} />
              </div>
            );
          })}
          {status === "submitted" && <p className="text-sm text-neutral-500">Thinking…</p>}
          {error && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {readableError(error)}
            </div>
          )}
          <div ref={bottom} />
        </div>
      </div>
      <div className="border-t border-neutral-200 p-4">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Message (Enter to send, Shift+Enter for a new line)"
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none rounded-md border border-neutral-300 px-3 py-2 outline-none focus:border-neutral-500"
          />
          <button
            onClick={send}
            disabled={busy || !input.trim()}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
}
