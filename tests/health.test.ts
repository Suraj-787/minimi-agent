import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index";
import { createApp } from "../src/server/app";
import { textModel } from "./helpers/mockModel";

describe("GET /api/health", () => {
  it("returns { ok: true }", async () => {
    const app = createApp({ db: openDb(":memory:"), models: { main: textModel(["hi"]) }, now: () => new Date() });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
