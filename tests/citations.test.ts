import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { linkCitations, sourcesOf, type Source } from "../web/src/lib/citations";

const src = (n: number, url = `https://site${n}.com/p`): Source => ({ n, url, title: `T${n}`, domain: `site${n}.com` });

describe("linkCitations", () => {
  it("links [n] when source n exists", () => {
    expect(linkCitations("Node 24 [1].", [src(1)])).toBe("Node 24 [\\[1\\]](https://site1.com/p).");
  });

  it("leaves [n] with no matching source as plain text", () => {
    expect(linkCitations("Claim [7] and [1].", [src(1)])).toBe("Claim [7] and [\\[1\\]](https://site1.com/p).");
    expect(linkCitations("Claim [2].", [])).toBe("Claim [2].");
  });

  it("does not touch code, array indexing or existing links", () => {
    const s = [src(1)];
    expect(linkCitations("use `a[1]` here", s)).toBe("use `a[1]` here");
    expect(linkCitations("```js\nx[1]\n[1]\n```", s)).toBe("```js\nx[1]\n[1]\n```");
    expect(linkCitations("arr[1] and [1](https://x.com)", s)).toBe("arr[1] and [1](https://x.com)");
  });

  it("only links http(s) URLs and escapes parentheses", () => {
    expect(linkCitations("x [1]", [src(1, "javascript:alert(1)")])).toBe("x [1]");
    expect(linkCitations("x [1]", [src(1, "https://a.com/f_(x)")])).toBe("x [\\[1\\]](https://a.com/f_%28x%29)");
  });
});

describe("sourcesOf", () => {
  it("reads n and date from providerMetadata and sorts by n", () => {
    const m = {
      id: "m",
      role: "assistant",
      parts: [
        { type: "source-url", sourceId: "src-2", url: "https://www.b.com/x", title: "B", providerMetadata: { search: { n: 2 } } },
        { type: "source-url", sourceId: "src-1", url: "https://a.com/x", providerMetadata: { search: { n: 1, publishedDate: "2026-11-09" } } },
        { type: "source-url", sourceId: "odd", url: "https://c.com" }, // no metadata → ignored
        { type: "text", text: "hi" },
      ],
    } as unknown as UIMessage;
    expect(sourcesOf(m)).toEqual([
      { n: 1, url: "https://a.com/x", title: "a.com", domain: "a.com", publishedDate: "2026-11-09" },
      { n: 2, url: "https://www.b.com/x", title: "B", domain: "b.com", publishedDate: undefined },
    ]);
  });
});
