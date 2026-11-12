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

export interface MemoryClaim {
  id: string;
  entity: string;
  attribute: string;
  value: string;
  sourceUrl: string | null;
  status: "current" | "superseded";
  said: string;
  validAsOf: string | null;
  lastVerified: string;
  threadId: string;
  threadTitle: string | null;
  previously: { value: string; said: string; until: string | null }[];
}
export interface MemoryDay {
  date: string;
  claims: MemoryClaim[];
}

export async function fetchMemory(status: "current" | "all"): Promise<MemoryDay[]> {
  return (await json<{ days: MemoryDay[] }>(await fetch(`/api/memory?status=${status}`))).days;
}

export async function forgetClaim(id: string): Promise<void> {
  const res = await fetch(`/api/memory/claims/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`${res.status} ${res.statusText}`);
}

export async function forgetChat(threadId: string): Promise<void> {
  const res = await fetch(`/api/memory/threads/${threadId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`${res.status} ${res.statusText}`);
}

/** Shape of GET /api/debug/:turnId; fields are optional where older traces may lack them. */
/** One search query as the trace keeps it (D74). Older traces have only query/provider/cached. */
export interface QueryReport {
  query: string;
  provider?: string;
  cached?: boolean;
  failedProviders?: string[];
  item?: string;
  domains?: string[];
  since?: string;
  failed?: boolean;
  empty?: "filter" | "none";
  results?: {
    url: string;
    title: string;
    publishedDate?: string;
    fate: "kept" | "duplicate" | "cap";
    n?: number;
    duplicateOf?: number;
    label?: string;
  }[];
}

export interface DebugInfo {
  intent: {
    verify?: boolean;
    news?: boolean;
    forcedSearch?: boolean;
    recheck?: { items?: number; claims?: { entity: string; attribute: string; said: string }[]; uncovered?: string[] };
  } | null;
  resolvedDates: { refs?: { text: string }[]; resolved?: string[]; ambiguous?: unknown[]; sinceDate?: string } | null;
  recallRules: string[];
  memory: {
    turns: { date: string | null; text: string }[];
    inThreadTurns: { date: string | null; text: string }[];
    claims: { entity: string; attribute: string; value: string; status: string; said: string }[];
    claimsTotal: number;
    omittedTurns: number;
    chars: number;
  };
  queries: QueryReport[];
  provider: string | null;
  timings: { contextMs: number | null; firstStatusMs?: number | null; firstTokenMs: number | null; totalMs: number | null };
  usage: { totalTokens?: number; steps?: number; retries?: number } | null;
  steps: {
    step: number;
    mode: "auto" | "force" | "none";
    thinking?: "tool" | "answer";
    modelMs: number;
    firstPartMs: number | null;
    searchMs: number;
    queries: number;
  }[];
  errors: unknown[];
  memoryWrites: {
    op: string;
    label: string;
    key?: string;
    value?: string;
    previous?: string[];
    reason?: string;
    field?: string;
    text?: string;
    stage?: string;
  }[];
}

export async function fetchDebug(turnId: string): Promise<DebugInfo | undefined> {
  const res = await fetch(`/api/debug/${turnId}`);
  if (res.status === 404) return undefined;
  return json<DebugInfo>(res);
}
