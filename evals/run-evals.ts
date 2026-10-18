/**
 * Runs the agent N times against the synthetic dataset and scores each run
 * against evals/ground-truth.json. Scoring rules live in evals/score.ts, and
 * aggregation across runs in evals/summary.ts.
 *
 * Usage: pnpm eval [--runs 3] [--model claude-sonnet-5-5] [--concurrency 1] [--strict]
 *
 * Agents are non-deterministic, so the summary reports the mean AND the worst
 * run for each metric; a target that only the best run meets isn't met.
 *
 * Exit code: 1 if no run produced a scoreable result (every run failed for
 * infrastructure reasons, or none started). With --strict, also 1 if the worst
 * scored run misses any target. Otherwise 0.
 *
 * Choices worth knowing:
 *   - The agent gets the same question and tools as `pnpm scout`. Nothing from
 *     the answer key reaches it; ground truth is only read to score a finished run.
 *   - Runs share one ReadOnlyDb. That's safe because every query opens its own
 *     connection (see src/tools/db.ts). It's closed only after every worker has
 *     settled, so one failing worker can't pull it out from under the others.
 *   - Concurrency defaults to 1 to stay clear of rate limits.
 *   - Ctrl-C aborts the runs in flight (they're scored on their findings so far
 *     and flagged) and starts no new ones.
 *   - The results file is rewritten after every run, so a crash or a second
 *     Ctrl-C can't lose runs that were already paid for.
 *   - Full results go to evals/results/<timestamp>.json (gitignored), tagged
 *     with a hash of the system prompt, tool definitions and question, and a
 *     hash of the answer key, so results from different versions can be told apart.
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { DB_FILENAME, DEFAULT_DATA_DIR, DEFAULT_GROUND_TRUTH_PATH } from '../src/data/generate.ts';
import type { GroundTruth } from '../src/data/scenario.ts';
import type { Finding } from '../src/findings.ts';
import {
  DEFAULT_QUESTION,
  SYSTEM_PROMPT,
  runAgent,
  totalTokens,
  type ToolCallRecord,
} from '../src/agent/run.ts';
import { TOOLS } from '../src/tools/index.ts';
import { ReadOnlyDb } from '../src/tools/db.ts';
import { TARGETS, recallTargetCount, scoreRun, type Ratio } from './score.ts';
import { INFRA_FAILURES, exitCodeFor, summarizeRuns, type EvalSummary, type MetricSummary, type ScoredRun } from './summary.ts';

const RESULTS_DIR = join(dirname(DEFAULT_GROUND_TRUTH_PATH), 'results');

const { values: args } = parseArgs({
  options: {
    runs: { type: 'string', default: '3' },
    model: { type: 'string', default: process.env.COST_SCOUT_MODEL ?? 'claude-sonnet-5-5' },
    concurrency: { type: 'string', default: '1' },
    strict: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (args.help) {
  console.log('Usage: pnpm eval [--runs 3] [--model <id>] [--concurrency 1] [--strict]');
  process.exit(0);
}
const runs = positiveInt('--runs', args.runs);
const concurrency = Math.min(positiveInt('--concurrency', args.concurrency), runs);
const model = args.model;

const dbPath = join(DEFAULT_DATA_DIR, DB_FILENAME);
if (!existsSync(dbPath) || !existsSync(DEFAULT_GROUND_TRUTH_PATH)) {
  console.error('No dataset or answer key found. Run `pnpm generate` first.');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key.');
  process.exit(1);
}

interface RunRecord extends ScoredRun {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  turns: number;
  findings: Finding[];
  toolCalls: ToolCallRecord[];
  summary: string;
}

const truthText = readFileSync(DEFAULT_GROUND_TRUTH_PATH, 'utf8');
const truth = JSON.parse(truthText) as GroundTruth;
const shortHash = (...parts: string[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex').slice(0, 12);
};
const promptHash = shortHash(SYSTEM_PROMPT, JSON.stringify(TOOLS), DEFAULT_QUESTION);
const groundTruthHash = shortHash(truthText);
const startedAt = new Date().toISOString();
const outPath = join(RESULTS_DIR, `${startedAt.replace(/[:.]/g, '-')}.json`);

const abort = new AbortController();
process.once('SIGINT', () => {
  console.error('\nStopping: runs in flight will be scored on their findings so far. Press Ctrl-C again to quit immediately.');
  abort.abort();
});

console.error(`Evaluating ${model}: ${runs} run(s), concurrency ${concurrency}, prompt ${promptHash}\n`);

const db = await ReadOnlyDb.open(dbPath);
const records: RunRecord[] = [];
let next = 0;
const worker = async () => {
  while (next < runs && !abort.signal.aborted) {
    const run = ++next;
    records.push(await evalRun(run));
    records.sort((a, b) => a.run - b.run);
    save();
  }
};
const settled = await Promise.allSettled(Array.from({ length: concurrency }, worker));
db.close();
const crashed = settled.flatMap((s) => (s.status === 'rejected' ? [s.reason] : []));

const summary = save();
for (const r of records) printRun(r);
printSummary(summary);
console.log(`\nSaved ${relative(process.cwd(), outPath)}`);
for (const e of crashed) console.error('A worker crashed:', e);
process.exitCode = crashed.length ? 1 : exitCodeFor(summary, args.strict);

/** Writes everything recorded so far. Called after each run and once at the end. */
function save(): EvalSummary {
  const summary = summarizeRuns(records, truth, runs);
  const output = {
    model,
    runs,
    concurrency,
    startedAt,
    savedAt: new Date().toISOString(),
    promptHash,
    groundTruthHash,
    question: DEFAULT_QUESTION,
    targets: TARGETS,
    summary,
    runRecords: records,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
  return summary;
}

// --- Running --------------------------------------------------------------

async function evalRun(run: number): Promise<RunRecord> {
  const started = new Date();
  const seen: ToolCallRecord[] = [];
  const onToolCall = (c: ToolCallRecord) => {
    seen.push(c);
    if (c.name === 'report_finding' && !c.isError) {
      console.error(`  [run ${run}] finding: ${(c.input as Finding).title}`);
    } else if (c.isError) {
      console.error(`  [run ${run}] ✗ ${c.name}: ${c.summary}`);
    }
  };
  console.error(`  [run ${run}] started`);

  let base: Omit<RunRecord, 'run' | 'startedAt' | 'finishedAt' | 'durationMs' | 'score'>;
  try {
    const result = await runAgent(DEFAULT_QUESTION, { db, model, signal: abort.signal, onToolCall });
    base = {
      stopReason: result.stopReason,
      ...(result.stopDetail && { stopDetail: result.stopDetail }),
      turns: result.turns,
      usage: result.usage,
      findings: result.findings,
      toolCalls: result.toolCalls,
      summary: result.summary,
    };
  } catch (e) {
    // Safety net: runAgent already turns API failures into stopReason 'api_error', so this only catches
    // unexpected exceptions. report_finding records its input unchanged, so its successful calls are the findings.
    base = {
      stopReason: 'error',
      stopDetail: e instanceof Error ? e.message : String(e),
      turns: Math.max(0, ...seen.map((c) => c.turn)),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      findings: seen.filter((c) => c.name === 'report_finding' && !c.isError).map((c) => c.input as Finding),
      toolCalls: seen,
      summary: '',
    };
  }
  const finished = new Date();
  console.error(`  [run ${run}] ${base.stopReason}: ${base.findings.length} findings, ${base.turns} turns`);
  return {
    run,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    ...base,
    score: scoreRun(base.findings, truth),
  };
}

// --- Printing ---------------------------------------------------------------

function printRun(r: RunRecord) {
  const s = r.score;
  const u = r.usage;
  console.log(`\n${'─'.repeat(100)}`);
  if (INFRA_FAILURES.has(r.stopReason)) {
    console.log(`Run ${r.run}  ${r.stopReason}  ✗ INFRASTRUCTURE FAILURE, not scored: ${r.stopDetail ?? 'no detail'}`);
    return;
  }
  const flag = r.stopReason === 'completed' ? '' : `  ⚠ STOPPED EARLY${r.stopDetail ? `: ${r.stopDetail}` : ''}`;
  console.log(`Run ${r.run}  ${r.stopReason}${flag}`);
  console.log(
    `${r.turns} turns · ${r.toolCalls.length} tool calls · ${fmtInt(totalTokens(u))} tokens ` +
      `(${fmtInt(u.inputTokens)} in, ${fmtInt(u.outputTokens)} out, ${fmtInt(u.cacheReadTokens)} cache read, ` +
      `${fmtInt(u.cacheWriteTokens)} cache write) · ${(r.durationMs / 1000).toFixed(0)} s`,
  );
  console.log(
    `Recall ${fmtRatio(s.recall)} (fully found ${s.fullyFound.num}/${s.fullyFound.den}) · ` +
      `Precision ${fmtRatio(s.precision)} · Decoys flagged ${s.decoysFlagged} · ` +
      `Savings accuracy ${fmtRatio(s.savingsAccuracy)} (${s.conservativeUnits} conservative, ${s.overestimateUnits} over)`,
  );

  console.log(`\nAgent findings${r.findings.length ? '' : ': none'}`);
  if (r.findings.length) {
    printTable(
      ['#', 'Finding', 'Resources', 'Estimate'],
      r.findings.map((f, i) => [`${i + 1}`, clip(f.title, 64), `${f.resource_ids.length}`, usd(f.estimated_monthly_savings_usd)]),
      [false, false, true, true],
    );
  }

  console.log('\nPlanted problems');
  printTable(
    ['Problem', 'Found', 'Coverage', 'By finding'],
    s.problems.map((p) => [
      p.found ? p.id : `${p.id} (${clip(p.title, 50)})`,
      p.fullyFound ? 'yes' : p.found ? 'partly' : 'MISSED',
      p.found ? `${p.coverage.num}/${p.coverage.den}` : '',
      p.matchedBy.map((i) => `#${i + 1}`).join(' '),
    ]),
  );

  if (s.units.length) {
    console.log('\nSavings (one row per unit: findings and problems priced together)');
    printTable(
      ['Unit', 'Size', 'Findings', 'Estimate', 'Expected', 'Range', 'Result'],
      s.units.map((x) => [
        clip(x.problemIds.join(' + '), 40),
        `${x.findingIndexes.length}f×${x.problemCount}p`,
        x.findingIndexes.map((i) => `#${i + 1}`).join(' '),
        usd(x.estimatedUsd),
        `${usd(x.expectedUsd)} ±${x.tolerancePct}%`,
        `${usd(x.lowUsd)}–${usd(x.highUsd)}`,
        (x.classification === 'overestimate' ? 'OVERESTIMATE' : x.classification) +
          (x.nonFiniteEstimate ? ' (estimate not a number)' : '') +
          (x.merged ? ` · merged (${x.problemCount} problems)` : ''),
      ]),
      [false, false, false, true, true, true, false],
    );
    for (const x of s.units.filter((x) => x.classification === 'conservative')) {
      console.log(`  Review ${x.problemIds.join(' + ')} (conservative): was the lower estimate a safer fix?`);
      for (const c of x.proposedChanges) console.log(`    change: ${clip(c.replace(/\s+/g, ' '), 180)}`);
    }
  }
  for (const p of s.foundNotPriced) {
    console.log(`  ${p.id}: found, not priced: coverage too low (${p.coverage.num}/${p.coverage.den}, no single finding covers half)`);
  }
  if (s.unpricedFindings.length) {
    console.log('\nUnpriced findings (estimate not in savings accuracy, checked against the problems they touch)');
    printTable(
      ['Finding', 'Touches', 'Estimate', 'Expected range', 'Check'],
      s.unpricedFindings.map((x) => [
        `#${x.index + 1} ${clip(x.title, 40)}`,
        x.problemIds.join(' + '),
        usd(x.estimatedUsd),
        `${usd(x.lowUsd)}–${usd(x.highUsd)}`,
        x.exceedsHigh ? 'ABOVE RANGE' : 'ok',
      ]),
      [false, false, true, true, false],
    );
  }

  console.log(`\nDecoy hits${s.decoyHits.length ? '' : ': none'}`);
  for (const h of s.decoyHits) console.log(`  #${h.findingIndex + 1} ${h.findingTitle} → ${h.resourceId}\n    ${h.reason}`);
  console.log(`False findings (match no planted problem)${s.falseFindings.length ? '' : ': none'}`);
  for (const f of s.falseFindings) console.log(`  #${f.index + 1} ${f.title}`);
}

function printSummary(sum: EvalSummary) {
  const mark = (pass?: boolean) => (pass === undefined ? '' : pass ? ' pass' : ' FAIL');
  const den = truth.findings.length;
  console.log(`\n${'═'.repeat(100)}`);
  console.log(
    `Summary: ${sum.completed} of ${sum.requested} runs completed (${sum.scored} scored) · ${model} · ` +
      `prompt ${promptHash} · answer key ${groundTruthHash} · ~${fmtInt(sum.meanTokens)} tokens/run`,
  );
  if (sum.started < sum.requested) console.log(`⚠ ${sum.requested - sum.started} run(s) never started (stopped by Ctrl-C).`);
  for (const f of sum.infraFailures) {
    console.log(`✗ Run ${f.run} excluded (${f.stopReason}): ${f.stopDetail ?? 'no detail'}`);
  }
  for (const f of sum.flagged) {
    console.log(`⚠ Run ${f.run} stopped early (${f.stopReason}), scored on its findings so far.`);
  }
  if (!sum.metrics) {
    console.log('\nNo scoreable runs.');
    return;
  }
  const m = sum.metrics;
  console.log('');
  const row = (name: string, x: MetricSummary, fmt: (v: number) => string, target: string) => [
    name,
    `${fmt(x.mean)}${mark(x.meanPass)}`,
    `${fmt(x.worst)}${mark(x.worstPass)}`,
    target,
  ];
  const ofProblems = (v: number) => `${num(v * den)}/${den}`;
  printTable(
    ['Metric', 'Mean', 'Worst run', 'Target'],
    [
      row('Recall', m.recall, ofProblems, `≥ ${recallTargetCount(den)}/${den}`),
      row('Fully found', m.fullyFound, ofProblems, 'reported'),
      row('Precision', m.precision, pct, `≥ ${pct(TARGETS.precision)}`),
      row('Decoys flagged', m.decoysFlagged, num, `${TARGETS.decoysFlagged}`),
      row('Savings accuracy', m.savingsAccuracy, pct, `≥ ${pct(TARGETS.savingsAccuracy)}`),
    ],
  );
  console.log(
    `Savings misses: ${sum.conservativeUnits} conservative unit(s) for human review (listed per run), ` +
      `${sum.overestimateUnits} overestimate(s). Merged units (3+ problems): ${sum.mergedUnits}.`,
  );
  console.log(
    `Not priced: ${sum.foundNotPriced} found-but-unpriced problem(s), ` +
      `${sum.unpricedAboveRange} unpriced estimate(s) above range.`,
  );
  console.log('\nHit rate per planted problem');
  printTable(
    ['Problem', 'Found', 'Fully found'],
    sum.problemHitRate.map((p) => [p.id, `${p.found.num}/${p.found.den}`, `${p.fullyFound.num}/${p.fullyFound.den}`]),
  );
}

function printTable(headers: string[], rows: string[][], rightAlign: boolean[] = []) {
  const widths = headers.map((h, c) => Math.max(h.length, ...rows.map((r) => (r[c] ?? '').length)));
  const line = (cells: string[]) =>
    '  ' + cells.map((cell, c) => (rightAlign[c] ? cell.padStart(widths[c]!) : cell.padEnd(widths[c]!))).join('  ').trimEnd();
  console.log(line(headers));
  console.log(line(widths.map((w) => '─'.repeat(w))));
  for (const r of rows) console.log(line(r));
}

function fmtRatio(r: Ratio) {
  return `${r.num}/${r.den} (${pct(r.value)})`;
}
/** Whole numbers as-is, means to one decimal. */
function num(x: number) {
  return Math.abs(x - Math.round(x)) < 1e-9 ? `${Math.round(x)}` : x.toFixed(1);
}
function pct(x: number) {
  return `${Math.round(x * 100)}%`;
}
function usd(x: number) {
  return `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtInt(x: number) {
  return Math.round(x).toLocaleString('en-US');
}
function clip(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function positiveInt(flag: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`${flag} must be a positive integer, got ${raw}`);
    process.exit(1);
  }
  return n;
}
