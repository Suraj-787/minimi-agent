import { useCallback, useEffect, useState } from "react";
import { fetchMemory, forgetChat, forgetClaim, type MemoryDay } from "../lib/api";

// Visible, editable memory (SPEC §12): every claim the agent holds, by the day it was said, with the
// old → new chain and a Forget button. All text is rendered as React text, never as HTML.
export function MemoryPanel() {
  const [days, setDays] = useState<MemoryDay[] | undefined>();
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const load = useCallback(() => {
    fetchMemory(showAll ? "all" : "current").then(setDays).catch(() => setError("Could not load memory."));
  }, [showAll]);
  useEffect(load, [load]);

  const act = (run: () => Promise<void>) => {
    void run().then(load).catch(() => setError("That did not work. Try again."));
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-y-auto px-4 py-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-lg font-semibold">What I remember</h1>
          <label className="flex items-center gap-2 text-sm text-neutral-600">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            Include replaced values
          </label>
        </div>
        {error && <p role="alert" className="mb-3 text-sm text-red-700">{error}</p>}
        {!days ? (
          <p className="text-neutral-500">Loading…</p>
        ) : days.length === 0 ? (
          <p className="text-neutral-500">Nothing yet. Facts I check for you show up here, dated.</p>
        ) : (
          days.map((day) => (
            <div key={day.date} className="mb-6">
              <h2 className="mb-2 text-sm font-medium text-neutral-500">{day.date}</h2>
              <ul className="space-y-2">
                {day.claims.map((c) => (
                  <li key={c.id} className="rounded-md border border-neutral-200 p-3 text-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium">
                          {c.entity} <span className="font-normal text-neutral-500">· {c.attribute}</span>
                        </div>
                        <div>
                          {c.value}
                          {c.status === "superseded" && <span className="ml-2 text-xs text-neutral-400">(replaced)</span>}
                        </div>
                        {c.previously.map((p) => (
                          <div key={`${p.said}-${p.value}`} className="text-xs text-neutral-500">
                            previously: {p.value} (said {p.said}
                            {p.until ? `, until ${p.until}` : ""})
                          </div>
                        ))}
                        <div className="mt-1 text-xs text-neutral-400">
                          said {c.said} · last verified {c.lastVerified}
                          {c.threadTitle ? ` · from “${c.threadTitle}”` : ""}
                          {c.sourceUrl && (
                            <>
                              {" · "}
                              <a href={c.sourceUrl} target="_blank" rel="noreferrer noopener" className="hover:underline">
                                source
                              </a>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                        <button
                          className="text-neutral-500 hover:text-red-600"
                          onClick={() => act(() => forgetClaim(c.id))}
                          title="Forgets this value and any earlier values of it"
                        >
                          Forget
                        </button>
                        {c.threadTitle !== null && (
                          <button
                            className="text-neutral-400 hover:text-red-600"
                            onClick={() => {
                              if (window.confirm(`Forget everything remembered from “${c.threadTitle}”? The chat itself stays.`)) {
                                act(() => forgetChat(c.threadId));
                              }
                            }}
                          >
                            Forget chat
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
