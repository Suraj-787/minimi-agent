import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index";
import { createApp } from "../src/server/app";
import { textModel, objectModel, emptyExtraction } from "./helpers/mockModel";
import { noSearch } from "./helpers/search";

describe("GET /api/health", () => {
  it("returns { ok: true }", async () => {
    const app = createApp({ db: openDb(":memory:"), models: { main: textModel(["hi"]), small: objectModel(emptyExtraction) }, now: () => new Date(), search: noSearch, maxSteps: 4 });
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
