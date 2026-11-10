import { APICallError, RetryError } from "ai";

// Provider errors can carry request details, so what reaches the chat is a fixed sentence per
// failure class, never the raw message (CLAUDE.md: no secrets in logs, traces or the client).

function statusOf(err: unknown): number | undefined {
  if (RetryError.isInstance(err)) return statusOf(err.lastError);
  if (APICallError.isInstance(err)) return err.statusCode;
  if (err instanceof Error) {
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === "number") return status;
    if (err.cause) return statusOf(err.cause);
  }
  return undefined;
}

/** Maps any thrown value to a short, user-readable sentence. */
export function friendlyError(err: unknown): string {
  const status = statusOf(err);
  // Gemini reports an invalid key as HTTP 400 "API key not valid", so match on the text too.
  // The message is only inspected here, never shown.
  const badKeyText = status === 400 && err instanceof Error && /api key/i.test(err.message);
  if (status === 401 || status === 403 || badKeyText) {
    return "The model provider rejected the API key. Check the key in .env and restart the server.";
  }
  if (status === 429) {
    return "The model provider is rate-limiting requests (the free tier has low limits). Wait a minute and try again.";
  }
  if (status !== undefined && status >= 500) {
    return "The model provider had a server error. Try again in a moment.";
  }
  if (err instanceof Error && err.name === "AI_LoadAPIKeyError") {
    return "No API key is configured for the model provider. Add it to .env and restart the server.";
  }
  return "Something went wrong while generating the answer. Try again.";
}
