import type { EvalCase } from "./cases";
import type { CheckResult } from "./checks";
import type { JudgeOutcome, RunResult } from "./runCase";

export interface CaseReport {
  case: EvalCase;
  runs: RunResult[];
  /** When this case finished, "YYYY-MM-DD HH:MM UTC". Differs between cases after a --resume. */
  ranAt?: string;
}

export interface RunMeta {
  provider: string;
  mainModel: string;
  smallModel: string;
  /** "tool low / answer default" */
  thinking: string;
  ranAt: string;
  repeat: number;
  pauseMs: number;
}

export function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2);
}

const ms = (n: number | undefined): string => (n === undefined ? "–" : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** "`gemini-flash-latest` → `gemini-3.5-flash-001`" when the provider reported a different id; the plain id otherwise. */
export function modelLabel(requested: string, resolved: string[]): string {
  const ids = [...new Set(resolved)].filter((r) => r !== requested);
  return ids.length === 0 ? `\`${requested}\`` : `\`${requested}\` → ${ids.map((i) => `\`${i}\``).join(", ")}`;
}

const resolvedOf = (runs: RunResult[], role: "main" | "small"): string[] => runs.flatMap((r) => (r.resolved?.[role] ? [r.resolved[role] as string] : []));

export const RERUN_LABEL = "(rerun after provider error)";
const wasRerun = (runs: RunResult[]): boolean => runs.some((r) => r.firstAttempt);

export const REVIEW_AT_OR_BELOW = 2;

export function judgeScore(j: JudgeOutcome): number | undefined {
  return "score" in j ? j.score : undefined;
}

/** "4, 5, 2 ⚠ review": every run's score, flagged when any is <= 2. A judge error shows as "err". */
export function judgeCell(runs: RunResult[]): string {
  const scores = runs.map((r) => judgeScore(r.judge));
  const text = scores.map((s) => (s === undefined ? "err" : String(s))).join(", ");
  return scores.some((s) => s !== undefined && s <= REVIEW_AT_OR_BELOW) ? `${text} ⚠ review` : text;
}

/** Hard checks that failed in at least one run, with how many runs failed them: `mustMention "Bun" (1/3)`. */
export function failedChecks(runs: RunResult[]): string[] {
  const counts = new Map<string, number>();
  for (const r of runs) for (const h of r.hard) if (!h.pass) counts.set(h.name, (counts.get(h.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (runs.length > 1 ? `${name} (${n}/${runs.length})` : name));
}

export function softWarnings(runs: RunResult[]): string[] {
  const counts = new Map<string, number>();
  for (const r of runs) for (const s of r.soft) if (!s.pass) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  return [...counts].map(([name, n]) => (runs.length > 1 ? `${name} (${n}/${runs.length})` : name));
}

export const passCount = (runs: RunResult[]): number => runs.filter((r) => r.passed).length;

function searchModeOf(runs: RunResult[]): string {
  return [...new Set(runs.map((r) => r.searchMode))].join(" / ");
}

const lastTurn = (r: RunResult) => r.turns[r.turns.length - 1];

/** One date, or "first → last" when a --resume carried the run over several days. */
function ranSpan(reports: CaseReport[], meta: RunMeta): string {
  const times = reports.flatMap((r) => (r.ranAt ? [r.ranAt] : [])).sort();
  const first = times[0] ?? meta.ranAt;
  const last = times[times.length - 1] ?? meta.ranAt;
  return first === last ? first : `${first} → ${last} (resumed across runs)`;
}

export function renderResults(reports: CaseReport[], meta: RunMeta): string {
  const allRuns = reports.flatMap((r) => r.runs);
  const full = reports.filter((r) => r.runs.length > 0 && passCount(r.runs) === r.runs.length).length;
  const turns = allRuns.flatMap((r) => r.turns);
  const first = median(turns.flatMap((t) => (t.firstTokenMs === null ? [] : [t.firstTokenMs])));
  const total = median(allRuns.flatMap((r) => (lastTurn(r)?.totalMs == null ? [] : [lastTurn(r)?.totalMs as number])));
  const searches = turns.length ? (turns.reduce((a, t) => a + t.searchCalls, 0) / turns.length).toFixed(2) : "0";
  const judged = allRuns.map((r) => judgeScore(r.judge)).filter((s): s is number => s !== undefined);
  const avgJudge = judged.length ? (judged.reduce((a, b) => a + b, 0) / judged.length).toFixed(2) : "–";

  const lines: string[] = [
    "# Eval results",
    "",
    `Uncached run against the real model. Ran ${ranSpan(reports, meta)}. Provider \`${meta.provider}\`, main ${modelLabel(meta.mainModel, allRuns.flatMap((r) => resolvedOf([r], "main")))}, small/judge ${modelLabel(meta.smallModel, allRuns.flatMap((r) => resolvedOf([r], "small")))}, thinking ${meta.thinking}.`,
    `Frozen clock per case (\`now\` in cases.json), ${meta.repeat} run${meta.repeat === 1 ? "" : "s"} per case, ${ms(meta.pauseMs)} pause between runs.`,
    "",
    "Pass/fail comes from the deterministic checks only. The judge score (1-5) is informational; a score of 2 or less is flagged for review. Soft checks are warnings.",
    "",
    "## Summary",
    "",
    `- Cases passing every run: **${full}/${reports.length}**`,
    `- Runs passing: **${passCount(allRuns)}/${allRuns.length}**`,
    ...(reports.some((r) => wasRerun(r.runs)) ? [`- Rerun after a provider error: ${reports.filter((r) => wasRerun(r.runs)).map((r) => r.case.id).join(", ")}`] : []),
    `- Median time to first token: ${ms(first)} · median total (last turn): ${ms(total)}`,
    `- Web searches per turn: ${searches} · mean judge score: ${avgJudge}`,
    "",
    "## Cases",
    "",
    "| Case | Search | Pass | Failed checks | Soft warnings | Judge | 1st token | Total |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of reports) {
    const failed = failedChecks(r.runs);
    const soft = softWarnings(r.runs);
    const ft = median(r.runs.flatMap((x) => (lastTurn(x)?.firstTokenMs == null ? [] : [lastTurn(x)?.firstTokenMs as number])));
    const tt = median(r.runs.flatMap((x) => (lastTurn(x)?.totalMs == null ? [] : [lastTurn(x)?.totalMs as number])));
    lines.push(
      `| ${r.case.id}${wasRerun(r.runs) ? ` ${RERUN_LABEL}` : ""} | ${searchModeOf(r.runs)} | ${passCount(r.runs) === r.runs.length ? "✅" : "❌"} ${passCount(r.runs)}/${r.runs.length} | ${cell(failed.join("; ") || "–")} | ${cell(soft.join("; ") || "–")} | ${judgeCell(r.runs)} | ${ms(ft)} | ${ms(tt)} |`,
    );
  }

  const flagged = reports.filter((r) => wasRerun(r.runs) || r.runs.some((x) => !x.passed || (judgeScore(x.judge) ?? 5) <= REVIEW_AT_OR_BELOW));
  if (flagged.length > 0) {
    lines.push("", "## Failures and reviews", "");
    for (const r of flagged) {
      lines.push(`### ${r.case.id}`, "");
      for (const x of r.runs) {
        // A rerun shows both attempts: the one lost to the provider problem, then the one that counts.
        const attempts = x.firstAttempt ? [{ run: x.firstAttempt, tag: `attempt 1 (discarded: ${(x.firstAttempt.infra ?? []).join("; ")})` }, { run: x, tag: "attempt 2 (counts)" }] : [{ run: x, tag: "" }];
        for (const { run, tag } of attempts) {
          const bad = run.hard.filter((h) => !h.pass);
          const j = "score" in run.judge ? `judge ${run.judge.score}: ${run.judge.reason}` : `judge error: ${run.judge.error}`;
          lines.push(`- run ${x.rep}${tag ? ` ${tag}` : ""}: ${run.passed ? "pass" : "FAIL"} — ${j}`);
          for (const b of bad) lines.push(`  - ✗ ${b.name}${b.detail ? `: ${b.detail}` : ""}`);
          if (!x.firstAttempt && run.infra?.length) lines.push(`  - infra: ${run.infra.join("; ")} (reran once, still failing)`);
        }
        if (x.infra?.length && x.firstAttempt) lines.push(`  - attempt 2 also had: ${x.infra.join("; ")}`);
      }
      lines.push("");
    }
  }
  lines.push("", "Full answers: `eval/transcripts/<case id>.md` (only the ones that were committed).", "");
  return lines.join("\n");
}

interface StepView {
  step?: number;
  mode?: string;
  modelMs?: number;
  searchMs?: number;
  finishReason?: string;
  textChars?: number;
  calls?: Array<{ kind?: string; toolChoice?: string; hasTools?: boolean; activeTools?: string[]; finishReason?: string; textChars?: number; toolCalls?: Array<{ name?: string; input?: string }> }>;
}

/** One line per step and per request (D72), so a failed step can be read without opening the database. */
export function renderSteps(steps: unknown[] | undefined): string[] {
  if (!steps || steps.length === 0) return [];
  const out = ["Steps:"];
  for (const raw of steps) {
    const s = raw as StepView;
    out.push(`- step ${(s.step ?? 0) + 1} (${s.mode ?? "?"}): model ${s.modelMs ?? "?"} ms, search ${s.searchMs ?? 0} ms, finish ${s.finishReason ?? "?"}, text ${s.textChars ?? 0} chars`);
    for (const c of s.calls ?? []) {
      const calls = (c.toolCalls ?? []).map((t) => `${t.name ?? "?"}(${t.input ?? ""})`).join(", ");
      out.push(
        `  - ${c.kind ?? "?"}: toolChoice ${c.toolChoice ?? "?"}, tools ${c.hasTools ? `[${(c.activeTools ?? []).join(", ")}]` : "none"} → finish ${c.finishReason ?? "?"}, text ${c.textChars ?? 0} chars${calls ? `, tool calls: ${calls}` : ""}`,
      );
    }
  }
  return out;
}

function checkLine(c: CheckResult): string {
  return `- ${c.pass ? "✓" : "✗"} ${c.name}${!c.pass && c.detail ? `: ${c.detail}` : ""}`;
}

/** Everything one case produced, readable without the database: questions, queries, full answers, checks, judge. */
export function renderTranscript(c: EvalCase, runs: RunResult[], meta: RunMeta): string {
  const lines = [
    `# ${c.id}`,
    "",
    `- Category: ${c.category}`,
    `- Clock: ${c.now} (${c.timezone}) · seed: ${c.seed ? "yes" : "no"}`,
    `- Search: ${searchModeOf(runs)}`,
    `- Models: ${meta.provider} · main ${modelLabel(meta.mainModel, resolvedOf(runs, "main"))} · small ${modelLabel(meta.smallModel, resolvedOf(runs, "small"))} · thinking ${meta.thinking}`,
    `- Ran: ${meta.ranAt}`,
    `- Pass: ${passCount(runs)}/${runs.length}`,
    "",
    `**Rubric:** ${c.rubric}`,
  ];
  const renderRun = (r: RunResult, title: string): void => {
    lines.push("", `## ${title} — ${r.passed ? "PASS" : "FAIL"}`);
    if (r.infra?.length) lines.push("", `Infrastructure: ${r.infra.join("; ")}`);
    for (const t of r.turns) {
      lines.push("", `**User:** ${t.message}`, "");
      if (t.queries.length) lines.push(`Searches: ${t.queries.map((q) => `\`${q}\``).join(", ")}`, "");
      lines.push(`**Assistant** (${t.status}, first token ${ms(t.firstTokenMs ?? undefined)}, total ${ms(t.totalMs ?? undefined)}):`, "", t.answer.replace(/^/gm, "> "));
      if (t.sources.length) {
        lines.push("", "Sources returned:");
        for (const s of t.sources) lines.push(`- [${s.n}] ${s.title} — ${s.url} — ${s.publishedDate ?? "undated"}`);
      }
      const steps = renderSteps(t.steps);
      if (steps.length) lines.push("", ...steps);
    }
    lines.push("", "Checks:", ...r.hard.map(checkLine), ...r.soft.map((s) => checkLine({ ...s, name: `(soft) ${s.name}` })));
    const took = r.judgeMs === undefined ? "" : ` [${ms(r.judgeMs)}]`;
    lines.push("", "score" in r.judge ? `Judge: ${r.judge.score}/5 — ${r.judge.reason}${took}` : `Judge: error (${r.judge.error})${took}`);
  };
  for (const r of runs) {
    if (r.firstAttempt) {
      renderRun(r.firstAttempt, `Run ${r.rep}, attempt 1 (discarded, provider error)`);
      renderRun(r, `Run ${r.rep}, attempt 2 ${RERUN_LABEL}`);
    } else renderRun(r, `Run ${r.rep}`);
  }
  return `${lines.join("\n")}\n`;
}
