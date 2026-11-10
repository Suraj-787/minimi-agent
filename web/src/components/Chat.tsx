import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { readableError } from "../lib/api";
import { buildChatBody } from "../lib/chatRequest";
import { linkCitations, sourcesOf, type Source } from "../lib/citations";
import { Markdown } from "./Markdown";
import { WhyDrawer } from "./WhyDrawer";

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
  prepareSendMessagesRequest: ({ id, messages }) => ({ body: buildChatBody(id, messages, timezone) }),
});

function textOf(m: UIMessage): string {
  return m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
}

function SourcesList({ sources }: { sources: Source[] }) {
  if (sources.length === 0) return null;
  return (
    <ol className="mt-3 space-y-1 border-t border-neutral-200 pt-2 text-xs text-neutral-600">
      {sources.map((s) => (
        <li key={s.n} className="flex gap-2">
          <span className="w-6 shrink-0 text-right text-neutral-400">[{s.n}]</span>
          <a href={s.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate hover:underline" title={s.title}>
            {s.title}
          </a>
          <span className="shrink-0 text-neutral-400">
            {s.domain}
            {s.publishedDate ? ` · ${s.publishedDate}` : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function Chat({ threadId, initialMessages, onTurnEnd }: Props) {
  // Transient data parts never reach message.parts; onData is the only place they show up.
  const [searchStatus, setSearchStatus] = useState("");
  const { messages, sendMessage, status, error, clearError } = useChat({
    id: threadId,
    messages: initialMessages,
    transport,
    onData: (part) => {
      if (part.type !== "data-status") return;
      const text = (part.data as { text?: unknown } | null)?.text;
      if (typeof text === "string") setSearchStatus(text);
    },
    onFinish: () => {
      setSearchStatus("");
      onTurnEnd();
    },
    onError: () => {
      setSearchStatus("");
      onTurnEnd(); // a failed turn still created a thread and an assistant row
    },
  });
  const [input, setInput] = useState("");
  const [whyTurn, setWhyTurn] = useState<string | undefined>();
  const bottom = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";
  // Hide the status once the answer text starts, so "Searching: …" never lingers over a streaming reply.
  const last = messages[messages.length - 1];
  const answering = last?.role === "assistant" && textOf(last) !== "";

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages, status, error]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    clearError();
    setSearchStatus("");
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
            const sources = sourcesOf(m);
            return m.role === "user" ? (
              <div key={m.id} className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl bg-neutral-900 px-4 py-2 text-white">
                {text}
              </div>
            ) : (
              <div key={m.id} className="max-w-[95%]">
                <Markdown text={linkCitations(text, sources)} />
                <SourcesList sources={sources} />
                {!(busy && m === last) && (
                  <button onClick={() => setWhyTurn(m.id)} className="mt-1 text-xs text-neutral-400 hover:text-neutral-700">
                    why?
                  </button>
                )}
              </div>
            );
          })}
          {busy && searchStatus && !answering ? (
            <p role="status" className="text-sm text-neutral-500">{searchStatus}</p>
          ) : (
            status === "submitted" && <p className="text-sm text-neutral-500">Thinking…</p>
          )}
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
      {whyTurn && <WhyDrawer turnId={whyTurn} onClose={() => setWhyTurn(undefined)} />}
    </section>
  );
}
