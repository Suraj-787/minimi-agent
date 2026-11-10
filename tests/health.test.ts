import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";

describe("GET /api/health", () => {
  it("returns { ok: true }", async () => {
    const res = await createApp().request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
