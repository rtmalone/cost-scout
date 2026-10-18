/**
 * Scores one agent run against the answer key. Pure: no I/O, no model calls,
 * and nothing here ever flows back into the agent. The harness only measures.
 *
 * Terms: a "planted problem" is a ground-truth finding; a "finding" is what the
 * agent reported.
 *
 * Rules (a hybrid of "any overlap" and "most of the resources"):
 *
 *   Match         A finding matches a planted problem if their resource_ids
 *                 overlap. One finding may match several planted problems (the
 *                 prompt asks for one finding per root cause and fix, so grouping
 *                 the AWS volumes with the Azure disk earns credit for both).
 *                 Several findings may match one planted problem (a split).
 *   Recall        Planted problems matched by any finding / all planted problems.
 *   Fully found   Found problems whose coverage is at least FULL_MATCH_THRESHOLD
 *                 / all planted problems. Reported alongside recall, no target.
 *   Precision     Findings that match at least one planted problem / all findings.
 *   Decoys        Findings that include any decoy resource_id, each listed with
 *                 the decoy's reason. A finding that also matches a planted
 *                 problem still counts: it would still touch a healthy resource.
 *   Coverage      Per found planted problem, the share of its resource_ids that
 *                 the matching findings include between them. Reported, no target.
 *   Savings       Compared per unit. A finding and a problem are joined for
 *                 pricing only when that finding ALONE covers at least
 *                 FULL_MATCH_THRESHOLD of the problem's resources; a unit is a
 *                 connected component of those edges. A thinner overlap still
 *                 counts the problem as found and still feeds coverage, but it
 *                 doesn't pull the problem's expected savings into the finding's
 *                 unit, so one sloppy finding can't chain unrelated problems into
 *                 a single, easy-to-hit total. A found problem with no qualifying
 *                 edge gets no unit and is reported as "found, not priced".
 *                 Unpriced findings (ones that match a problem but sit in no
 *                 unit) don't affect savings accuracy, but their estimates are
 *                 still listed against the expected range of the problems they
 *                 touch and flagged exceedsHigh when above it, so a wild number
 *                 can't hide behind a thin match. A finding touching several
 *                 problems is compared with the sum of their high bounds (each
 *                 at its own tolerance), mirroring how units sum. A non-finite
 *                 estimate counts as exceeding.
 *                 Within a unit, the summed estimates of its findings are compared
 *                 with the summed expected savings of its problems, using the
 *                 largest tolerance among them. Every finding and every problem
 *                 is in at most one unit, so each dollar is counted once. Each
 *                 unit is:
 *                   within        inside expected ± tolerance (bounds inclusive)
 *                   conservative  below the range
 *                   overestimate  above the range (a failure); also any unit
 *                                 whose estimate isn't a finite number (NaN,
 *                                 Infinity), so bad math can never score within
 *                 Savings accuracy = within units / all units. Conservative units
 *                 are not failures, but they don't count as within either; they're
 *                 listed with their proposed_change for a human to judge.
 *                 "Conservative" is an automatic approximation: the harness can't
 *                 tell a deliberately safer fix (downsize instead of stop, archive
 *                 before delete) from bad math, hence the human review. A unit of
 *                 MERGED_UNIT_PROBLEMS or more problems is flagged as merged.
 *
 * An empty run scores 0 on precision and savings accuracy rather than "n/a", so
 * it can never pass a target by saying nothing.
 */

import type { Finding } from '../src/findings.ts';
import type { GroundTruth } from '../src/data/scenario.ts';

/** Share of a problem's resources needed for "fully found" (all findings together) and for a pricing edge (one finding). */
export const FULL_MATCH_THRESHOLD = 0.5;
/** Units that merge this many problems or more are flagged, so a lucky total is easy to spot. */
export const MERGED_UNIT_PROBLEMS = 3;

export interface Ratio {
  num: number;
  den: number;
  /** num / den, or 0 when den is 0. */
  value: number;
}

export type SavingsClass = 'within' | 'conservative' | 'overestimate';

export interface ProblemScore {
  id: string;
  title: string;
  found: boolean;
  /** Found, with coverage at least FULL_MATCH_THRESHOLD. */
  fullyFound: boolean;
  /** Indexes into the run's findings: every finding that overlaps the problem. */
  matchedBy: number[];
  /** Covered resources / all of the problem's resources. 0 when not found. */
  coverage: Ratio;
}

export interface DecoyHit {
  findingIndex: number;
  findingTitle: string;
  resourceId: string;
  reason: string;
}

export interface SavingsUnit {
  problemIds: string[];
  findingIndexes: number[];
  /** Number of planted problems in the unit. */
  problemCount: number;
  /** problemCount >= MERGED_UNIT_PROBLEMS. */
  merged: boolean;
  estimatedUsd: number;
  expectedUsd: number;
  tolerancePct: number;
  lowUsd: number;
  highUsd: number;
  classification: SavingsClass;
  /** The summed estimate was NaN or ±Infinity; classified as an overestimate. */
  nonFiniteEstimate: boolean;
  /** The findings' proposed changes, so a human can judge a conservative estimate. */
  proposedChanges: string[];
}

/** A finding that matches at least one planted problem but is in no savings unit. */
export interface UnpricedFinding {
  index: number;
  title: string;
  estimatedUsd: number;
  /** Every planted problem the finding touches. */
  problemIds: string[];
  /** Summed bounds of those problems, each at its own tolerance. */
  lowUsd: number;
  highUsd: number;
  /** Estimate above highUsd, or not a finite number. */
  exceedsHigh: boolean;
}

export interface RunScore {
  recall: Ratio;
  fullyFound: Ratio;
  precision: Ratio;
  decoysFlagged: number;
  savingsAccuracy: Ratio;
  problems: ProblemScore[];
  decoyHits: DecoyHit[];
  /** Findings that match no planted problem, by index. They may or may not include decoys. */
  falseFindings: { index: number; title: string }[];
  units: SavingsUnit[];
  /** Found problems that no single finding covers enough of to price. */
  foundNotPriced: {
    id: string;
    title: string;
    coverage: Ratio;
    expectedUsd: number;
    lowUsd: number;
    highUsd: number;
    /** Indexes of the findings that touch it (all unpriced). */
    findingIndexes: number[];
  }[];
  unpricedFindings: UnpricedFinding[];
  /** unpricedFindings with exceedsHigh. */
  unpricedAboveRange: number;
  conservativeUnits: number;
  overestimateUnits: number;
}

export interface Targets {
  recall: number;
  precision: number;
  decoysFlagged: number;
  savingsAccuracy: number;
}

/** From PLAN.md: recall ≥ 7 of 8, precision ≥ 85%, no decoys, savings accuracy ≥ 75%. */
export const TARGETS: Targets = { recall: 7 / 8, precision: 0.85, decoysFlagged: 0, savingsAccuracy: 0.75 };

/** Absorbs float noise at bounds, e.g. 276.48 × 1.15. */
const EPSILON = 1e-9;
const EPSILON_USD = 1e-6;

export function ratio(num: number, den: number): Ratio {
  return { num, den, value: den === 0 ? 0 : num / den };
}

/** The recall target as a count of problems, e.g. 7 of 8. Same test as meetsTarget('recall', …). */
export function recallTargetCount(problemCount: number, t: Targets = TARGETS): number {
  return Math.ceil(t.recall * problemCount - EPSILON);
}

export function scoreRun(findings: Finding[], truth: GroundTruth): RunScore {
  const findingIds = findings.map((f) => new Set(f.resource_ids));
  const problemIds = truth.findings.map((p) => [...new Set(p.resource_ids)]);
  const overlap = (pi: number, fi: number) => problemIds[pi]!.filter((id) => findingIds[fi]!.has(id)).length;
  const matchesOf = problemIds.map((_, pi) => findings.flatMap((_, fi) => (overlap(pi, fi) > 0 ? [fi] : [])));
  const pricedBy = problemIds.map((ids, pi) =>
    matchesOf[pi]!.filter((fi) => overlap(pi, fi) >= FULL_MATCH_THRESHOLD * ids.length - EPSILON),
  );

  const problems: ProblemScore[] = truth.findings.map((p, pi) => {
    const ids = problemIds[pi]!;
    const matchedBy = matchesOf[pi]!;
    const covered = ids.filter((id) => matchedBy.some((fi) => findingIds[fi]!.has(id))).length;
    const coverage = ratio(covered, ids.length);
    const found = matchedBy.length > 0;
    const fullyFound = found && coverage.value >= FULL_MATCH_THRESHOLD - EPSILON;
    return { id: p.id, title: p.title, found, fullyFound, matchedBy, coverage };
  });

  const matchedFindings = new Set(matchesOf.flat());
  const falseFindings = findings.flatMap((f, i) => (matchedFindings.has(i) ? [] : [{ index: i, title: f.title }]));

  const decoyReason = new Map(truth.decoys.map((d) => [d.resource_id, d.reason]));
  const decoyHits: DecoyHit[] = findings.flatMap((f, i) =>
    [...findingIds[i]!]
      .filter((id) => decoyReason.has(id))
      .map((id) => ({ findingIndex: i, findingTitle: f.title, resourceId: id, reason: decoyReason.get(id)! })),
  );

  const units = savingsUnits(findings, truth, pricedBy);
  const within = units.filter((u) => u.classification === 'within').length;
  const bounds = (pi: number) => {
    const p = truth.findings[pi]!;
    const e = p.expected_monthly_savings_usd;
    return { expectedUsd: e, lowUsd: e * (1 - p.tolerance_pct / 100), highUsd: e * (1 + p.tolerance_pct / 100) };
  };
  const foundNotPriced = problems.flatMap((p, pi) =>
    p.found && pricedBy[pi]!.length === 0
      ? [{ id: p.id, title: p.title, coverage: p.coverage, ...bounds(pi), findingIndexes: p.matchedBy }]
      : [],
  );

  const inUnit = new Set(units.flatMap((u) => u.findingIndexes));
  const unpricedFindings: UnpricedFinding[] = findings.flatMap((f, fi) => {
    if (!matchedFindings.has(fi) || inUnit.has(fi)) return [];
    const touched = matchesOf.flatMap((m, pi) => (m.includes(fi) ? [pi] : []));
    const lowUsd = touched.reduce((sum, pi) => sum + bounds(pi).lowUsd, 0);
    const highUsd = touched.reduce((sum, pi) => sum + bounds(pi).highUsd, 0);
    const est = f.estimated_monthly_savings_usd;
    return [
      {
        index: fi,
        title: f.title,
        estimatedUsd: est,
        problemIds: touched.map((pi) => truth.findings[pi]!.id),
        lowUsd,
        highUsd,
        exceedsHigh: !Number.isFinite(est) || est > highUsd + EPSILON_USD,
      },
    ];
  });

  return {
    recall: ratio(problems.filter((p) => p.found).length, problems.length),
    fullyFound: ratio(problems.filter((p) => p.fullyFound).length, problems.length),
    precision: ratio(matchedFindings.size, findings.length),
    decoysFlagged: new Set(decoyHits.map((h) => h.findingIndex)).size,
    savingsAccuracy: ratio(within, units.length),
    problems,
    decoyHits,
    falseFindings,
    units,
    foundNotPriced,
    unpricedFindings,
    unpricedAboveRange: unpricedFindings.filter((u) => u.exceedsHigh).length,
    conservativeUnits: units.filter((u) => u.classification === 'conservative').length,
    overestimateUnits: units.filter((u) => u.classification === 'overestimate').length,
  };
}

/** Connected components of the pricing edges, walked from each unvisited problem that has one. */
function savingsUnits(findings: Finding[], truth: GroundTruth, pricedBy: number[][]): SavingsUnit[] {
  const problemsOf = findings.map((_, fi) => pricedBy.flatMap((m, pi) => (m.includes(fi) ? [pi] : [])));
  const seenProblems = new Set<number>();
  const units: SavingsUnit[] = [];

  for (let start = 0; start < truth.findings.length; start++) {
    if (seenProblems.has(start) || pricedBy[start]!.length === 0) continue;
    const unitProblems = new Set<number>([start]);
    const unitFindings = new Set<number>();
    const queue = [start];
    seenProblems.add(start);
    while (queue.length) {
      for (const fi of pricedBy[queue.shift()!]!) {
        if (unitFindings.has(fi)) continue;
        unitFindings.add(fi);
        for (const pi of problemsOf[fi]!) {
          if (seenProblems.has(pi)) continue;
          seenProblems.add(pi);
          unitProblems.add(pi);
          queue.push(pi);
        }
      }
    }

    const ps = [...unitProblems].sort((a, b) => a - b).map((pi) => truth.findings[pi]!);
    const fis = [...unitFindings].sort((a, b) => a - b);
    const expectedUsd = ps.reduce((s, p) => s + p.expected_monthly_savings_usd, 0);
    const estimatedUsd = fis.reduce((s, i) => s + findings[i]!.estimated_monthly_savings_usd, 0);
    const tolerancePct = Math.max(...ps.map((p) => p.tolerance_pct));
    const lowUsd = expectedUsd * (1 - tolerancePct / 100);
    const highUsd = expectedUsd * (1 + tolerancePct / 100);
    units.push({
      problemIds: ps.map((p) => p.id),
      findingIndexes: fis,
      problemCount: ps.length,
      merged: ps.length >= MERGED_UNIT_PROBLEMS,
      estimatedUsd,
      expectedUsd,
      tolerancePct,
      lowUsd,
      highUsd,
      classification: classifySavings(estimatedUsd, lowUsd, highUsd),
      nonFiniteEstimate: !Number.isFinite(estimatedUsd),
      proposedChanges: fis.map((i) => findings[i]!.proposed_change),
    });
  }
  return units;
}

/** A non-finite estimate (NaN, ±Infinity) is an overestimate: it can never pass as within. */
export function classifySavings(estimatedUsd: number, lowUsd: number, highUsd: number): SavingsClass {
  if (!Number.isFinite(estimatedUsd)) return 'overestimate';
  if (estimatedUsd < lowUsd - EPSILON_USD) return 'conservative';
  if (estimatedUsd > highUsd + EPSILON_USD) return 'overestimate';
  return 'within';
}

/** Decoys flagged must be at or below its target; the rest must be at or above. */
export function meetsTarget(metric: keyof Targets, value: number, t: Targets = TARGETS): boolean {
  return metric === 'decoysFlagged' ? value <= t.decoysFlagged : value >= t[metric] - EPSILON;
}
