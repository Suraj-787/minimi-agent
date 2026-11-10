import type { ReactNode } from "react";

interface Props {
  view: "chat" | "memory";
  chat: ReactNode;
  memory: ReactNode;
}

/**
 * Chat stays MOUNTED (just hidden) while the Memory tab is open. Unmounting it threw away useChat's state,
 * and the remount was seeded with the messages loaded before the last turn, so a new chat came back blank
 * until a refresh (D56). Memory is mounted only while it is open, so it loads fresh data every time.
 * `hidden` is a class, not the attribute: the section's own `display: flex` would override the attribute.
 */
export function ViewSwitch({ view, chat, memory }: Props) {
  return (
    <>
      <div className={view === "chat" ? "flex min-w-0 flex-1" : "hidden"} aria-hidden={view !== "chat"} data-view="chat">
        {chat}
      </div>
      {view === "memory" && memory}
    </>
  );
}
