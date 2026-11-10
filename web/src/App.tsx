import { useCallback, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import { Chat } from "./components/Chat";
import { MemoryPanel } from "./components/MemoryPanel";
import { ViewSwitch } from "./components/ViewSwitch";
import { Sidebar } from "./components/Sidebar";
import { deleteThread, fetchMessages, fetchThreads, type ThreadSummary } from "./lib/api";

// The active thread lives in the URL hash so a refresh lands on the same chat.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idFromHash = () => {
  const h = window.location.hash.slice(1);
  return UUID.test(h) ? h : undefined;
};

export function App() {
  const [threadId, setThreadId] = useState<string>(() => idFromHash() ?? crypto.randomUUID());
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [initial, setInitial] = useState<UIMessage[] | undefined>();
  const [view, setView] = useState<"chat" | "memory">("chat");
  const [loadError, setLoadError] = useState<string | undefined>();

  const refreshThreads = useCallback(() => {
    fetchThreads().then(setThreads).catch(() => setLoadError("Could not reach the server."));
  }, []);

  useEffect(() => {
    window.location.hash = threadId;
  }, [threadId]);

  useEffect(() => {
    const onHash = () => {
      const id = idFromHash();
      if (id) setThreadId(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(refreshThreads, [refreshThreads]);

  useEffect(() => {
    let live = true;
    setInitial(undefined);
    setLoadError(undefined);
    fetchMessages(threadId)
      .then((m) => live && setInitial(m))
      .catch(() => live && setLoadError("Could not load this chat."));
    return () => {
      live = false;
    };
  }, [threadId]);

  const remove = (id: string) => {
    void deleteThread(id).then(() => {
      refreshThreads();
      if (id === threadId) setThreadId(crypto.randomUUID());
    });
  };

  return (
    <div className="flex h-screen">
      <Sidebar
        threads={threads}
        activeId={threadId}
        onSelect={(id) => (setView("chat"), setThreadId(id))}
        onNew={() => (setView("chat"), setThreadId(crypto.randomUUID()))}
        onDelete={remove}
        view={view}
        onView={setView}
      />
      <ViewSwitch
        view={view}
        memory={<MemoryPanel />}
        chat={
          loadError ? (
            <p className="m-auto text-red-700">{loadError}</p>
          ) : initial ? (
            <Chat key={threadId} threadId={threadId} initialMessages={initial} onTurnEnd={refreshThreads} />
          ) : (
            <p className="m-auto text-neutral-500">Loading…</p>
          )
        }
      />
    </div>
  );
}
