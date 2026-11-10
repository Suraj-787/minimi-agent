import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ViewSwitch } from "../web/src/components/ViewSwitch";
import { buildChatBody } from "../web/src/lib/chatRequest";

const render = (view: "chat" | "memory") =>
  renderToStaticMarkup(h(ViewSwitch, { view, chat: h("section", { id: "chat" }, "history"), memory: h("section", { id: "mem" }, "claims") }));

describe("ViewSwitch (chat tab ↔ memory tab, D56)", () => {
  it("keeps the chat in the page while Memory is open, hidden but not unmounted", () => {
    const html = render("memory");
    expect(html).toContain('id="chat"');
    expect(html).toContain("history");
    expect(html).toMatch(/class="hidden"[^>]*data-view="chat"|data-view="chat"[^>]*class="hidden"/);
    expect(html).toContain('id="mem"');
  });

  it("shows the chat and does not mount Memory while the chat is open, so Memory loads fresh each time it opens", () => {
    const html = render("chat");
    expect(html).toContain('id="chat"');
    expect(html).not.toContain('id="mem"');
    expect(html).not.toContain('class="hidden"');
    expect(html).toContain("flex min-w-0 flex-1");
  });
});

describe("buildChatBody", () => {
  const user = (text: string) => ({ parts: [{ type: "text" as const, text }] });
  const TID = "55555555-5555-4555-8555-555555555555";

  it("sends the thread id useChat was created with, never a new one, and only the newest message", () => {
    const a = buildChatBody(TID, [user("first"), { parts: [{ type: "text", text: "reply" }] }, user("second")], "Asia/Kolkata");
    const b = buildChatBody(TID, [user("third")], "Asia/Kolkata");
    expect(a).toEqual({ threadId: TID, message: { text: "second" }, timezone: "Asia/Kolkata" });
    expect(b.threadId).toBe(a.threadId); // a blank-state send and a later send address the same thread
  });

  it("ignores non-text parts and tolerates an empty list", () => {
    expect(buildChatBody(TID, [{ parts: [{ type: "step-start" as never }, { type: "text", text: "hi" }] }], "UTC").message.text).toBe("hi");
    expect(buildChatBody(TID, [], "UTC").message.text).toBe("");
  });
});
