import type { UIMessage } from "ai";

export interface ThreadSummary {
  id: string;
  title: string;
  updated_at: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export async function fetchThreads(): Promise<ThreadSummary[]> {
  return (await json<{ threads: ThreadSummary[] }>(await fetch("/api/threads"))).threads;
}

/** A thread that has no messages yet (a brand-new client-side UUID) is just an empty chat. */
export async function fetchMessages(threadId: string): Promise<UIMessage[]> {
  const res = await fetch(`/api/threads/${threadId}/messages`);
  if (res.status === 404) return [];
  return (await json<{ messages: UIMessage[] }>(res)).messages;
}

export async function deleteThread(threadId: string): Promise<void> {
  const res = await fetch(`/api/threads/${threadId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`${res.status} ${res.statusText}`);
}

/** The server replies to bad requests with {error}; useChat surfaces the raw body, so unwrap it. */
export function readableError(err: Error): string {
  try {
    const parsed: unknown = JSON.parse(err.message);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Not JSON: it is already a sentence (e.g. the in-stream provider error).
  }
  return err.message;
}
