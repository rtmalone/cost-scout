import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_GROUND_TRUTH_PATH } from '../src/data/generate.ts';
import { buildGroundTruth, type GroundTruth } from '../src/data/scenario.ts';
import type { Finding } from '../src/findings.ts';
import {
  FULL_MATCH_THRESHOLD,
  classifySavings,
  meetsTarget,
  recallTargetCount,
  scoreRun,
  type RunScore,
} from '../evals/score.ts';

/** A small answer key: three planted problems and one decoy. */
const TRUTH: GroundTruth = {
  analysis_date: '2026-10-01',
  period: { start: '2026-07-03', days: 90 },
  findings: [
    { id: 'a', category: 'storage', title: 'Problem A', resource_ids: ['a1', 'a2'], expected_monthly_savings_usd: 100, tolerance_pct: 10 },
    { id: 'b', category: 'compute', title: 'Problem B', resource_ids: ['b1'], expected_monthly_savings_usd: 50, tolerance_pct: 20 },
    {
      id: 'c',
      category: 'storage',
      title: 'Problem C',
      resource_ids: ['c1', 'c2', 'c3', 'c4'],
      expected_monthly_savings_usd: 200,
      tolerance_pct: 10,
    },
  ],
  decoys: [{ resource_id: 'd1', reason: 'Looks idle but is busy.' }],
};

function finding(resource_ids: string[], usd: number, title = resource_ids.join(',')): Finding {
  return {
    title,
    category: 'other',
    resource_ids,
    evidence: 'test',
    estimated_monthly_savings_usd: usd,
    proposed_change: `change for ${title}`,
    rollback: 'undo',
    risk: 'low',
    approval_notes: 'owner',
  };
}

const problem = (s: RunScore, id: string) => s.problems.find((p) => p.id === id)!;
const classes = (s: RunScore) => Object.fromEntries(s.units.map((u) => [u.problemIds.join('+'), u.classification]));

describe('scoreRun', () => {
  it('scores a perfect run', () => {
    const s = scoreRun([finding(['a1', 'a2'], 100), finding(['b1'], 50), finding(['c1', 'c2', 'c3', 'c4'], 200)], TRUTH);
    assert.deepEqual([s.recall.num, s.recall.den], [3, 3]);
    assert.deepEqual([s.precision.num, s.precision.den], [3, 3]);
    assert.equal(s.decoysFlagged, 0);
    assert.deepEqual([s.savingsAccuracy.num, s.savingsAccuracy.den], [3, 3]);
    assert.ok(s.problems.every((p) => p.found && p.coverage.value === 1));
    assert.deepEqual(s.falseFindings, []);
  });

  it('counts a planted problem with no matching finding as missed', () => {
    const s = scoreRun([finding(['a1', 'a2'], 100), finding(['c1', 'c2', 'c3', 'c4'], 200)], TRUTH);
    assert.deepEqual([s.recall.num, s.recall.den], [2, 3]);
    assert.equal(problem(s, 'b').found, false);
    assert.equal(problem(s, 'b').title, 'Problem B');
    assert.equal(s.precision.value, 1);
    assert.equal(s.units.length, 2);
  });

  it('counts a finding that matches nothing as a false finding, outside any savings unit', () => {
    const s = scoreRun([finding(['a1', 'a2'], 100), finding(['x1'], 999, 'Made-up waste')], TRUTH);
    assert.deepEqual([s.precision.num, s.precision.den], [1, 2]);
    assert.deepEqual(s.falseFindings, [{ index: 1, title: 'Made-up waste' }]);
    assert.equal(s.decoysFlagged, 0);
    assert.equal(s.units.length, 1);
    assert.deepEqual(s.units[0]!.findingIndexes, [0]);
  });

  it('flags a decoy with its reason, alone or inside a finding that also matches a planted problem', () => {
    const s = scoreRun([finding(['d1'], 10, 'Idle box'), finding(['a1', 'a2', 'd1'], 100, 'Volumes')], TRUTH);
    assert.equal(s.decoysFlagged, 2);
    assert.deepEqual(
      s.decoyHits.map((h) => [h.findingIndex, h.resourceId, h.reason]),
      [
        [0, 'd1', 'Looks idle but is busy.'],
        [1, 'd1', 'Looks idle but is busy.'],
      ],
    );
    // The mixed finding still matches A, so it isn't a false finding; the decoy-only one is.
    assert.equal(problem(s, 'a').found, true);
    assert.deepEqual([s.precision.num, s.precision.den], [1, 2]);
    assert.deepEqual(s.falseFindings, [{ index: 0, title: 'Idle box' }]);
  });

  it('credits one grouped finding for every planted problem it covers, scored against the summed savings', () => {
    const s = scoreRun([finding(['a1', 'a2', 'b1'], 150)], TRUTH);
    assert.equal(problem(s, 'a').found, true);
    assert.equal(problem(s, 'b').found, true);
    assert.deepEqual([s.precision.num, s.precision.den], [1, 1]);
    assert.equal(s.units.length, 1);
    const u = s.units[0]!;
    assert.deepEqual(u.problemIds, ['a', 'b']);
    assert.equal(u.expectedUsd, 150);
    assert.equal(u.tolerancePct, 20, 'uses the largest tolerance in the unit');
    assert.equal(u.merged, false);
    assert.equal(u.classification, 'within');

    // 125 is inside 150 ±20% but would be outside ±10%: the larger tolerance applies.
    assert.equal(scoreRun([finding(['a1', 'a2', 'b1'], 125)], TRUTH).units[0]!.classification, 'within');
  });

  it('sums the estimates of findings that split one planted problem', () => {
    const s = scoreRun([finding(['c1', 'c2'], 100), finding(['c3', 'c4'], 100)], TRUTH);
    assert.deepEqual(problem(s, 'c').matchedBy, [0, 1]);
    assert.deepEqual(problem(s, 'c').coverage, { num: 4, den: 4, value: 1 });
    assert.deepEqual([s.precision.num, s.precision.den], [2, 2]);
    assert.equal(s.units.length, 1);
    assert.equal(s.units[0]!.estimatedUsd, 200);
    assert.equal(s.units[0]!.classification, 'within');
  });

  it('merges chained matches into one unit so no dollar is counted twice', () => {
    // Finding 0 spans A and B; finding 1 spans B and C. All three problems form one unit.
    const s = scoreRun([finding(['a1', 'a2', 'b1'], 150), finding(['b1', 'c1', 'c2', 'c3', 'c4'], 200)], TRUTH);
    assert.equal(s.units.length, 1);
    const u = s.units[0]!;
    assert.deepEqual(u.problemIds, ['a', 'b', 'c']);
    assert.deepEqual(u.findingIndexes, [0, 1]);
    assert.equal(u.estimatedUsd, 350);
    assert.equal(u.expectedUsd, 350);
    assert.equal(u.problemCount, 3);
    assert.equal(u.merged, true);
  });

  it('reports partial coverage, and leaves a thin match found but unpriced', () => {
    const s = scoreRun([finding(['c1'], 50)], TRUTH);
    assert.equal(problem(s, 'c').found, true);
    assert.equal(problem(s, 'c').fullyFound, false);
    assert.deepEqual(problem(s, 'c').coverage, { num: 1, den: 4, value: 0.25 });
    assert.deepEqual(s.units, []);
    assert.deepEqual(
      s.foundNotPriced.map((p) => p.id),
      ['c'],
    );
    assert.deepEqual(s.savingsAccuracy, { num: 0, den: 0, value: 0 });
  });

  it('prices a problem only through a finding that alone covers at least half of it', () => {
    // Exactly half of C (2 of 4) qualifies; a quarter doesn't.
    const half = scoreRun([finding(['c1', 'c2'], 200)], TRUTH);
    assert.equal(FULL_MATCH_THRESHOLD, 0.5);
    assert.deepEqual(half.units[0]!.problemIds, ['c']);
    // With an odd count, 1 of 3 is below half and 2 of 3 is above.
    const odd: GroundTruth = {
      ...TRUTH,
      findings: [{ ...TRUTH.findings[2]!, id: 'odd', resource_ids: ['o1', 'o2', 'o3'] }],
    };
    assert.equal(scoreRun([finding(['o1'], 200)], odd).units.length, 0);
    assert.equal(scoreRun([finding(['o1', 'o2'], 200)], odd).units.length, 1);
    // A grouped finding with a thin overlap on B doesn't pull B's savings into A's unit.
    const thin: GroundTruth = {
      ...TRUTH,
      findings: [TRUTH.findings[0]!, { ...TRUTH.findings[2]!, id: 'c' }],
    };
    const s = scoreRun([finding(['a1', 'a2', 'c1'], 100)], thin);
    assert.deepEqual(
      s.units.map((u) => u.problemIds),
      [['a']],
    );
    assert.equal(s.units[0]!.classification, 'within');
    assert.deepEqual(
      s.foundNotPriced.map((p) => p.id),
      ['c'],
    );
  });

  it('counts fully found on the union of matching findings', () => {
    // Two findings with one resource each: together half of C, so fully found, but neither alone prices it.
    const s = scoreRun([finding(['c1'], 50), finding(['c2'], 50), finding(['a1'], 10)], TRUTH);
    assert.equal(problem(s, 'c').fullyFound, true);
    assert.equal(problem(s, 'a').fullyFound, true, '1 of 2 is half');
    assert.deepEqual([s.fullyFound.num, s.fullyFound.den], [2, 3]);
    assert.deepEqual(
      s.units.map((u) => u.problemIds),
      [['a']],
    );
    assert.deepEqual(
      s.foundNotPriced.map((p) => p.id),
      ['c'],
    );
  });

  it("doesn't let one broad finding merge problems it barely touches", () => {
    const wide: GroundTruth = {
      ...TRUTH,
      findings: ['p', 'q', 'r', 's'].map((id) => ({
        id,
        category: 'storage' as const,
        title: `Problem ${id}`,
        resource_ids: [1, 2, 3, 4].map((n) => `${id}${n}`),
        expected_monthly_savings_usd: 100,
        tolerance_pct: 10,
      })),
    };
    // Estimate equals the sum of all four expected savings, which a chained unit would score as within.
    const s = scoreRun([finding(['p1', 'q1', 'r1', 's1'], 400)], wide);
    assert.deepEqual([s.recall.num, s.recall.den], [4, 4]);
    assert.deepEqual([s.fullyFound.num, s.fullyFound.den], [0, 4]);
    assert.deepEqual(s.units, []);
    assert.equal(s.foundNotPriced.length, 4);
    assert.deepEqual(s.savingsAccuracy, { num: 0, den: 0, value: 0 });
  });

  it('lists an unpriced estimate and flags it above range, without touching savings accuracy', () => {
    // #0 prices C on its own; #1 overlaps C thinly with a wild estimate.
    const s = scoreRun([finding(['c1', 'c2', 'c3'], 200), finding(['c4'], 9999, 'Wild')], TRUTH);
    assert.deepEqual([s.savingsAccuracy.num, s.savingsAccuracy.den], [1, 1]);
    assert.deepEqual(s.units[0]!.findingIndexes, [0]);
    assert.equal(s.unpricedFindings.length, 1);
    const u = s.unpricedFindings[0]!;
    assert.deepEqual([u.index, u.title, u.estimatedUsd, u.problemIds], [1, 'Wild', 9999, ['c']]);
    assert.ok(Math.abs(u.highUsd - 220) < 1e-9);
    assert.equal(u.exceedsHigh, true);
    assert.equal(s.unpricedAboveRange, 1);
  });

  it('records found-not-priced problems with their range and touching findings', () => {
    const s = scoreRun([finding(['c1'], 150)], TRUTH);
    const p = s.foundNotPriced[0]!;
    assert.deepEqual([p.id, p.expectedUsd, p.findingIndexes], ['c', 200, [0]]);
    assert.ok(Math.abs(p.lowUsd - 180) < 1e-9 && Math.abs(p.highUsd - 220) < 1e-9);
    assert.equal(s.unpricedFindings[0]!.exceedsHigh, false, '150 is below the range, not above it');
    assert.equal(scoreRun([finding(['c1'], 220)], TRUTH).unpricedFindings[0]!.exceedsHigh, false, 'bound inclusive');
    assert.equal(s.unpricedAboveRange, 0);
  });

  it('compares an unpriced finding touching several problems with their summed high bounds', () => {
    const wide: GroundTruth = {
      ...TRUTH,
      findings: ['p', 'q'].map((id) => ({
        id,
        category: 'storage' as const,
        title: id,
        resource_ids: [1, 2, 3, 4].map((n) => `${id}${n}`),
        expected_monthly_savings_usd: 100,
        tolerance_pct: 10,
      })),
    };
    assert.equal(scoreRun([finding(['p1', 'q1'], 220)], wide).unpricedFindings[0]!.exceedsHigh, false);
    assert.equal(scoreRun([finding(['p1', 'q1'], 221)], wide).unpricedFindings[0]!.exceedsHigh, true);
    assert.equal(scoreRun([finding(['p1', 'q1'], NaN)], wide).unpricedFindings[0]!.exceedsHigh, true);
  });

  it('never classifies a non-finite estimate as within', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const s = scoreRun([finding(['a1', 'a2'], bad)], TRUTH);
      assert.equal(s.units[0]!.classification, 'overestimate', String(bad));
      assert.equal(s.units[0]!.nonFiniteEstimate, true);
      assert.deepEqual([s.savingsAccuracy.num, s.savingsAccuracy.den], [0, 1]);
    }
    // One bad finding in a split poisons the whole unit.
    const split = scoreRun([finding(['c1', 'c2'], 100), finding(['c3', 'c4'], NaN)], TRUTH);
    assert.equal(split.units[0]!.classification, 'overestimate');
    assert.equal(classifySavings(NaN, 0, 100), 'overestimate');
  });

  it("doesn't double count coverage when findings overlap the same resource", () => {
    const s = scoreRun([finding(['c1', 'c2'], 100), finding(['c2', 'c3'], 100)], TRUTH);
    assert.deepEqual(problem(s, 'c').coverage, { num: 3, den: 4, value: 0.75 });
  });

  it('ignores duplicate resource IDs within a finding', () => {
    const s = scoreRun([finding(['a1', 'a1', 'd1', 'd1'], 50)], TRUTH);
    assert.deepEqual(problem(s, 'a').coverage, { num: 1, den: 2, value: 0.5 });
    assert.equal(s.decoyHits.length, 1);
    assert.equal(s.decoysFlagged, 1);
  });

  it('treats a finding with no resource IDs as a false finding', () => {
    const s = scoreRun([finding([], 100, 'Nothing')], TRUTH);
    assert.deepEqual(s.falseFindings, [{ index: 0, title: 'Nothing' }]);
    assert.deepEqual(s.units, []);
    assert.deepEqual([s.precision.num, s.precision.den], [0, 1]);
  });

  it('handles an empty answer key', () => {
    const s = scoreRun([finding(['a1'], 10)], { ...TRUTH, findings: [], decoys: [] });
    assert.deepEqual(s.recall, { num: 0, den: 0, value: 0 });
    assert.deepEqual(s.fullyFound, { num: 0, den: 0, value: 0 });
    assert.deepEqual([s.precision.num, s.precision.den], [0, 1]);
    assert.deepEqual(s.units, []);
  });

  it('classifies savings at the tolerance boundaries (bounds inclusive)', () => {
    const cls = (usd: number) => scoreRun([finding(['a1', 'a2'], usd)], TRUTH).units[0]!.classification;
    assert.equal(cls(90), 'within');
    assert.equal(cls(110), 'within');
    assert.equal(cls(89.99), 'conservative');
    assert.equal(cls(110.01), 'overestimate');
    // Float noise at a real bound (276.48 × 0.85 = 235.008) doesn't flip the result.
    assert.equal(classifySavings(276.48 * 0.85, 276.48 * (1 - 15 / 100), 276.48 * 1.15), 'within');
  });

  it('scores an empty run as zero, not n/a', () => {
    const s = scoreRun([], TRUTH);
    assert.deepEqual(s.recall, { num: 0, den: 3, value: 0 });
    assert.deepEqual(s.precision, { num: 0, den: 0, value: 0 });
    assert.deepEqual(s.savingsAccuracy, { num: 0, den: 0, value: 0 });
    assert.equal(s.decoysFlagged, 0);
    assert.deepEqual(s.units, []);
    assert.equal(meetsTarget('precision', s.precision.value), false);
  });
});

describe('meetsTarget', () => {
  it('applies the PLAN.md targets', () => {
    assert.equal(meetsTarget('recall', 7 / 8), true);
    assert.equal(meetsTarget('recall', 6 / 8), false);
    assert.equal(meetsTarget('precision', 0.85), true);
    assert.equal(meetsTarget('decoysFlagged', 0), true);
    assert.equal(meetsTarget('decoysFlagged', 1), false);
    assert.equal(meetsTarget('savingsAccuracy', 0.75), true);
    assert.equal(meetsTarget('savingsAccuracy', 4 / 6), false);
  });

  it('derives the recall target count from the number of problems', () => {
    assert.equal(recallTargetCount(8), 7);
    assert.equal(recallTargetCount(16), 14);
    assert.equal(recallTargetCount(10), 9, 'ceil(8.75)');
    assert.equal(meetsTarget('recall', 9 / 10), true);
    assert.equal(meetsTarget('recall', 8 / 10), false);
  });
});

describe('scoreRun against the real answer key', () => {
  const truth = JSON.parse(readFileSync(DEFAULT_GROUND_TRUTH_PATH, 'utf8')) as GroundTruth;

  it('reads an answer key that matches the scenario', () => {
    assert.deepEqual(truth, buildGroundTruth());
  });

  it('reproduces the first live run: 7/8, 6/6, no decoys, two conservative estimates', () => {
    const snaps = Array.from({ length: 12 }, (_, i) => `snap-0c1d2e3f4a5b600${String(i + 1).padStart(2, '0')}`);
    const azureDisk =
      '/subscriptions/sub-3f9c2a71/resourceGroups/rg-analytics/providers/Microsoft.Compute/disks/analytics-scratch-disk';
    const s = scoreRun(
      [
        finding(['nat-0a9b8c7d6e5f40051'], 1248, 'NAT spike'),
        finding(['i-0a2b3c4d5e6f70061', 'i-0a2b3c4d5e6f70062'], 314, 'Dev schedule'),
        finding(['vol-0f1e2d3c4b5a60041', 'vol-0f1e2d3c4b5a60042', azureDisk], 285, 'Unattached disks'),
        finding(['i-0e8f7a6b5c4d30031'], 207, 'Idle m5.2xlarge'),
        finding(snaps, 90, 'Old snapshots'),
        finding(['vol-0b2c3d4e5f6a70021', 'vol-0b2c3d4e5f6a70022'], 40, 'gp2 to gp3'),
      ],
      truth,
    );

    assert.deepEqual([s.recall.num, s.recall.den], [7, 8]);
    assert.deepEqual(
      s.problems.filter((p) => !p.found).map((p) => p.id),
      ['oversized-lambda'],
    );
    assert.deepEqual([s.fullyFound.num, s.fullyFound.den], [7, 8]);
    assert.deepEqual([s.precision.num, s.precision.den], [6, 6]);
    assert.equal(s.decoysFlagged, 0);
    assert.deepEqual(s.foundNotPriced, []);
    assert.deepEqual(s.unpricedFindings, []);
    assert.equal(s.unpricedAboveRange, 0);
    assert.ok(s.units.every((u) => !u.merged));
    assert.ok(s.problems.filter((p) => p.found).every((p) => p.coverage.value === 1));

    assert.deepEqual(classes(s), {
      'gp2-to-gp3': 'within',
      'idle-ec2': 'conservative',
      'unattached-ebs+azure-unattached-disk': 'within',
      'old-snapshots': 'conservative',
      'nat-spike': 'within',
      'dev-always-on': 'within',
    });
    const grouped = s.units.find((u) => u.problemIds.length === 2)!;
    assert.equal(grouped.expectedUsd, 150 + 135.17);
    // 4 within of 6 units: below the 75% target, because conservative units don't count as within.
    assert.deepEqual([s.savingsAccuracy.num, s.savingsAccuracy.den], [4, 6]);
    assert.equal(s.conservativeUnits, 2);
    assert.equal(s.overestimateUnits, 0);
  });
});
