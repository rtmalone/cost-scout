/**
 * Aggregates scored runs into the eval summary. Pure, so the rules are tested
 * without a model or a database.
 *
 *   - A run that failed for infrastructure reasons (api_error, or an exception
 *     out of runAgent) says nothing about the agent, so it's left out of the
 *     mean and worst-run metrics and listed separately with its detail.
 *   - A run the agent itself cut short (max_turns, token_budget, max_tokens,
 *     refusal, context_window_exceeded) or that was aborted mid-run is scored
 *     on its findings so far, and flagged.
 *   - "Worst" is the lowest value, except for decoys flagged, where it's the
 *     highest.
 *   - Exit code: 1 when no run produced a scoreable result; with --strict, also
 *     1 when the worst scored run misses any target. Otherwise 0.
 */

import type { GroundTruth } from '../src/data/scenario.ts';
import type { StopReason, Usage } from '../src/agent/run.ts';
import { totalTokens } from '../src/agent/run.ts';
import { TARGETS, meetsTarget, ratio, type Ratio, type RunScore, type Targets } from './score.ts';

export type RunStop = StopReason | 'error';

/** The fields of a run record that the summary needs. */
export interface ScoredRun {
  run: number;
  stopReason: RunStop;
  stopDetail?: string;
  usage: Usage;
  score: RunScore;
}

export interface MetricSummary {
  mean: number;
  worst: number;
  /** Undefined for reported-only metrics with no target. */
  meanPass?: boolean;
  worstPass?: boolean;
}

export interface EvalSummary {
  /** Runs asked for with --runs. */
  requested: number;
  /** Runs that started (fewer than requested after Ctrl-C). */
  started: number;
  /** Runs whose stopReason is 'completed'. */
  completed: number;
  /** Runs included in the metrics: everything except infrastructure failures. */
  scored: number;
  infraFailures: { run: number; stopReason: RunStop; stopDetail?: string }[];
  /** Scored runs that didn't complete: the agent stopped early or was aborted. */
  flagged: { run: number; stopReason: RunStop; stopDetail?: string }[];
  /** Undefined when no run was scored. */
  metrics?: {
    recall: MetricSummary;
    fullyFound: MetricSummary;
    precision: MetricSummary;
    decoysFlagged: MetricSummary;
    savingsAccuracy: MetricSummary;
  };
  /** Per planted problem, over scored runs. */
  problemHitRate: { id: string; found: Ratio; fullyFound: Ratio }[];
  conservativeUnits: number;
  overestimateUnits: number;
  mergedUnits: number;
  /** Found-but-unpriced problems, summed over scored runs. */
  foundNotPriced: number;
  /** Unpriced findings whose estimate is above the expected range, summed over scored runs. */
  unpricedAboveRange: number;
  meanTokens: number;
  /** Every target met by the worst scored run. False when nothing was scored. */
  worstMeetsAllTargets: boolean;
}

export const INFRA_FAILURES: ReadonlySet<RunStop> = new Set<RunStop>(['api_error', 'error']);

export function summarizeRuns(runs: ScoredRun[], truth: GroundTruth, requested: number, t: Targets = TARGETS): EvalSummary {
  const scored = runs.filter((r) => !INFRA_FAILURES.has(r.stopReason));
  const brief = (r: ScoredRun) => ({ run: r.run, stopReason: r.stopReason, ...(r.stopDetail && { stopDetail: r.stopDetail }) });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  const metric = (pick: (s: RunScore) => number, target?: keyof Targets): MetricSummary => {
    const xs = scored.map((r) => pick(r.score));
    const m = mean(xs);
    const worst = target === 'decoysFlagged' ? Math.max(...xs) : Math.min(...xs);
    if (!target) return { mean: m, worst };
    return { mean: m, worst, meanPass: meetsTarget(target, m, t), worstPass: meetsTarget(target, worst, t) };
  };
  const metrics = scored.length
    ? {
        recall: metric((s) => s.recall.value, 'recall'),
        fullyFound: metric((s) => s.fullyFound.value),
        precision: metric((s) => s.precision.value, 'precision'),
        decoysFlagged: metric((s) => s.decoysFlagged, 'decoysFlagged'),
        savingsAccuracy: metric((s) => s.savingsAccuracy.value, 'savingsAccuracy'),
      }
    : undefined;
  const sumOf = (pick: (s: RunScore) => number) => scored.reduce((n, r) => n + pick(r.score), 0);

  return {
    requested,
    started: runs.length,
    completed: runs.filter((r) => r.stopReason === 'completed').length,
    scored: scored.length,
    infraFailures: runs.filter((r) => INFRA_FAILURES.has(r.stopReason)).map(brief),
    flagged: scored.filter((r) => r.stopReason !== 'completed').map(brief),
    ...(metrics && { metrics }),
    problemHitRate: truth.findings.map((p, pi) => ({
      id: p.id,
      found: ratio(scored.filter((r) => r.score.problems[pi]!.found).length, scored.length),
      fullyFound: ratio(scored.filter((r) => r.score.problems[pi]!.fullyFound).length, scored.length),
    })),
    conservativeUnits: sumOf((s) => s.conservativeUnits),
    overestimateUnits: sumOf((s) => s.overestimateUnits),
    mergedUnits: sumOf((s) => s.units.filter((u) => u.merged).length),
    foundNotPriced: sumOf((s) => s.foundNotPriced.length),
    unpricedAboveRange: sumOf((s) => s.unpricedAboveRange),
    meanTokens: mean(scored.map((r) => totalTokens(r.usage))),
    worstMeetsAllTargets:
      !!metrics &&
      [metrics.recall, metrics.precision, metrics.decoysFlagged, metrics.savingsAccuracy].every((m) => m.worstPass),
  };
}

export function exitCodeFor(summary: EvalSummary, strict: boolean): 0 | 1 {
  if (summary.scored === 0) return 1;
  if (strict && !summary.worstMeetsAllTargets) return 1;
  return 0;
}
