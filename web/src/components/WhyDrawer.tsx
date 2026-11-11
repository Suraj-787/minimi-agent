import { useEffect, useState, type ReactNode } from "react";
import { fetchDebug, type DebugInfo } from "../lib/api";

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${v} ms`);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {children}
    </div>
  );
}

// "blocked" = the injection scanner stopped it; "skipped" = a policy check declined it. Colour is not
// the only cue: the word is always shown.
const badge: Record<string, string> = {
  blocked: "bg-red-100 text-red-800",
  skipped: "bg-neutral-200 text-neutral-700",
  failed: "bg-amber-100 text-amber-800",
};

export function WhyDrawer({ turnId, onClose }: { turnId: string; onClose: () => void }) {
  const [info, setInfo] = useState<DebugInfo | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    fetchDebug(turnId)
      .then((d) => live && setInfo(d ?? null))
      .catch(() => live && setInfo(null));
    return () => {
      live = false;
    };
  }, [turnId]);

  const intent = info?.intent;
  const cues = [intent?.verify && "verify", intent?.news && "news", intent?.forcedSearch && "forced search"].filter(Boolean);
  const recheck = intent?.recheck;
  const missing = (info?.errors ?? []).flatMap((e) =>
    e && typeof e === "object" && "verifyTakeawayMissing" in e ? [(e as { verifyTakeawayMissing: string[] }).verifyTakeawayMissing] : [],
  );

  return (
    <aside role="dialog" aria-label="Why this answer" className="fixed inset-y-0 right-0 z-10 w-full max-w-md overflow-y-auto border-l border-neutral-200 bg-white p-4 text-sm shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Why this answer?</h2>
        <button onClick={onClose} aria-label="Close" className="text-neutral-500 hover:text-neutral-900">×</button>
      </div>
      {info === undefined && <p className="text-neutral-500">Loading…</p>}
      {info === null && <p className="text-neutral-500">No trace for this answer.</p>}
      {info && (
        <>
          <Section title="Memory rules fired">
            <p>{info.recallRules.join(", ") || "none"}</p>
            {info.recallRules.length <= 1 && <p className="text-xs text-neutral-500">No cross-chat memory was used.</p>}
          </Section>
          <Section title="Dates resolved">
            {info.resolvedDates?.refs?.length ? (
              <ul className="list-disc pl-5">
                {info.resolvedDates.refs.map((r) => <li key={r.text}>“{r.text}”</li>)}
              </ul>
            ) : (
              <p className="text-neutral-500">none</p>
            )}
            {info.resolvedDates?.resolved?.length ? <p>Looked up: {info.resolvedDates.resolved.join(", ")}</p> : null}
            {info.resolvedDates?.ambiguous?.length ? (
              <p className="text-amber-700">Ambiguous: {JSON.stringify(info.resolvedDates.ambiguous)}</p>
            ) : null}
            {info.resolvedDates?.sinceDate && <p>Since: {info.resolvedDates.sinceDate}</p>}
          </Section>
          <Section title="Intent">
            <p>{cues.length ? cues.join(", ") : "plain question"}</p>
            {recheck?.claims && recheck.claims.length > 0 && (
              <>
                <p>Re-checking {recheck.claims.length} item(s):</p>
                <ul className="list-disc pl-5">
                  {recheck.claims.map((c, i) => (
                    <li key={i}>{c.entity} — {c.attribute} <span className="text-neutral-500">(said {c.said})</span></li>
                  ))}
                </ul>
              </>
            )}
            {missing.map((m) => (
              <p key={m.join()} className="text-amber-700">Takeaway skipped: {m.join(", ")}</p>
            ))}
          </Section>
          <Section title="Memory recalled">
            {info.memory.turns.length + info.memory.claims.length === 0 ? (
              <p className="text-neutral-500">nothing</p>
            ) : (
              <>
                <ul className="list-disc pl-5">
                  {info.memory.turns.map((t, i) => <li key={i}>{t.date}: {t.text}</li>)}
                  {info.memory.claims.map((c, i) => (
                    <li key={`c${i}`}>
                      {c.entity} · {c.attribute}: {c.value}{" "}
                      <span className="text-neutral-500">({c.status} at recall, said {c.said})</span>
                    </li>
                  ))}
                </ul>
                {info.memory.claimsTotal > info.memory.claims.length && <p className="text-xs text-neutral-500">+{info.memory.claimsTotal - info.memory.claims.length} more claims</p>}
                {info.memory.omittedTurns > 0 && <p className="text-xs text-neutral-500">{info.memory.omittedTurns} turn(s) left out to fit the size cap</p>}
                <p className="text-xs text-neutral-500">{info.memory.chars} characters</p>
              </>
            )}
          </Section>
          <Section title="Searches">
            {info.queries.length === 0 ? (
              <p className="text-neutral-500">none</p>
            ) : (
              <ul className="list-disc pl-5">
                {info.queries.map((q, i) => (
                  <li key={i}>
                    {q.query} — {q.provider}
                    {q.cached ? " (cached)" : ""}
                    {q.failedProviders?.length ? ` · fell back from ${q.failedProviders.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section title="Timings">
            <p>
              Context {ms(info.timings.contextMs)} · first status {ms(info.timings.firstStatusMs)} · first token{" "}
              {ms(info.timings.firstTokenMs)} · total {ms(info.timings.totalMs)}
            </p>
            {info.usage?.retries ? <p>Model retries: {info.usage.retries}</p> : null}
          </Section>
          <Section title="Steps (model vs search)">
            {(info.steps ?? []).length === 0 ? (
              <p className="text-neutral-500">not recorded for this answer</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left text-neutral-500">
                  <tr>
                    <th className="pr-2 font-normal">Step</th>
                    <th className="pr-2 font-normal">Model</th>
                    <th className="pr-2 font-normal">1st part</th>
                    <th className="font-normal">Search</th>
                  </tr>
                </thead>
                <tbody>
                  {info.steps.map((s) => (
                    <tr key={s.step}>
                      <td className="pr-2">
                        {s.step + 1} {s.mode === "force" ? "forced" : s.mode === "none" ? "answer only" : ""}
                        {s.thinking ? <span className="text-neutral-500"> · {s.thinking} thinking</span> : null}
                      </td>
                      <td className="pr-2">{ms(s.modelMs)}</td>
                      <td className="pr-2">{ms(s.firstPartMs)}</td>
                      <td>{s.queries > 0 ? `${ms(s.searchMs)} (${s.queries} q)` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          <Section title="Memory writes">
            {info.memoryWrites.length === 0 ? (
              <p className="text-neutral-500">none (or still being written)</p>
            ) : (
              <ul className="space-y-1">
                {info.memoryWrites.map((w, i) => (
                  <li key={i}>
                    <span className={`mr-2 rounded px-1.5 py-0.5 text-xs ${badge[w.label] ?? "bg-emerald-100 text-emerald-800"}`}>{w.label}</span>
                    {w.key && <span className="font-mono text-xs">{w.key}</span>}
                    {w.value && <span> = {w.value}</span>}
                    {w.previous?.length ? <span className="text-neutral-500"> (was {w.previous.join("; ")})</span> : null}
                    {!w.key && w.field ? `${w.field}: ` : ""}
                    {!w.key && !w.value ? (w.text ?? "") : ""}
                    {w.reason ? <span className="text-neutral-500"> — {w.reason}</span> : null}
                    {w.stage ? <span className="text-neutral-500"> — {w.stage}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </aside>
  );
}
