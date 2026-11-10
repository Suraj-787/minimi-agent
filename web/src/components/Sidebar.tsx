import type { ThreadSummary } from "../lib/api";

interface Props {
  threads: ThreadSummary[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  view: "chat" | "memory";
  onView: (v: "chat" | "memory") => void;
}

export function Sidebar({ threads, activeId, onSelect, onNew, onDelete, view, onView }: Props) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
      <button
        onClick={onNew}
        className="m-3 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-700"
      >
        New chat
      </button>
      <div role="tablist" className="mx-3 mb-2 flex gap-1 text-sm">
        {(["chat", "memory"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => onView(v)}
            className={`flex-1 rounded-md px-2 py-1 ${view === v ? "bg-neutral-200 font-medium" : "hover:bg-neutral-100"}`}
          >
            {v === "chat" ? "Chats" : "Memory"}
          </button>
        ))}
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {threads.length === 0 && <p className="px-2 text-sm text-neutral-500">No chats yet.</p>}
        {threads.map((t) => (
          <div
            key={t.id}
            className={`group flex items-center rounded-md ${t.id === activeId ? "bg-neutral-200" : "hover:bg-neutral-100"}`}
          >
            <button
              onClick={() => onSelect(t.id)}
              className="min-w-0 flex-1 truncate px-2 py-2 text-left text-sm"
              title={t.title}
            >
              {t.title || "Untitled"}
            </button>
            <button
              onClick={() => onDelete(t.id)}
              aria-label={`Delete ${t.title || "chat"}`}
              className="px-2 text-neutral-400 opacity-0 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
            >
              ×
            </button>
          </div>
        ))}
      </nav>
    </aside>
  );
}
