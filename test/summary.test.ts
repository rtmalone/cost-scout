import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GroundTruth } from '../src/data/scenario.ts';
import type { Finding } from '../src/findings.ts';
import { scoreRun } from '../evals/score.ts';
import { exitCodeFor, summarizeRuns, type RunStop, type ScoredRun } from '../evals/summary.ts';

/** Four planted problems, so the default recall target is 4 of 4 (ceil of 3.5). */
const TRUTH: GroundTruth = {
  analysis_date: '2026-10-01',
  period: { start: '2026-07-03', days: 90 },
  findings: ['a', 'b', 'c', 'd'].map((id) => ({
    id,
    category: 'storage' as const,
    title: `Problem ${id}`,
    resource_ids: [`${id}1`],
    expected_monthly_savings_usd: 100,
    tolerance_pct: 10,
  })),
  decoys: [{ resource_id: 'x1', reason: 'fine' }],
};

function finding(ids: string[], usd = 100): Finding {
  return {
    title: ids.join(','),
    category: 'other',
    resource_ids: ids,
    evidence: '',
    estimated_monthly_savings_usd: usd,
    proposed_change: '',
    rollback: '',
    risk: 'low',
    approval_notes: '',
  };
}

function run(n: number, stopReason: RunStop, findings: Finding[], stopDetail?: string): ScoredRun {
  return {
    run: n,
    stopReason,
    ...(stopDetail && { stopDetail }),
    usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    score: scoreRun(findings, TRUTH),
  };
}

const perfect = ['a1', 'b1', 'c1', 'd1'].map((id) => finding([id]));

describe('summarizeRuns', () => {
  it('reports the mean and the worst scored run', () => {
    const s = summarizeRuns(
      [run(1, 'completed', perfect), run(2, 'completed', [...perfect.slice(0, 2), finding(['x1'])])],
      TRUTH,
      2,
    );
    assert.equal(s.metrics!.recall.mean, 0.75);
    assert.equal(s.metrics!.recall.worst, 0.5);
    assert.equal(s.metrics!.recall.worstPass, false);
    assert.equal(s.metrics!.decoysFlagged.worst, 1, 'worst decoys is the highest');
    assert.equal(s.metrics!.fullyFound.meanPass, undefined, 'reported only');
    assert.deepEqual(s.problemHitRate[0]!.found, { num: 2, den: 2, value: 1 });
    assert.deepEqual(s.problemHitRate[3]!.found, { num: 1, den: 2, value: 0.5 });
    assert.equal(s.worstMeetsAllTargets, false);
  });

  it('excludes infrastructure failures from the metrics and lists them with their detail', () => {
    const s = summarizeRuns(
      [run(1, 'completed', perfect), run(2, 'api_error', [], '529 overloaded'), run(3, 'error', [finding(['a1'])], 'boom')],
      TRUTH,
      3,
    );
    assert.equal(s.completed, 1);
    assert.equal(s.scored, 1);
    assert.deepEqual(s.infraFailures, [
      { run: 2, stopReason: 'api_error', stopDetail: '529 overloaded' },
      { run: 3, stopReason: 'error', stopDetail: 'boom' },
    ]);
    assert.equal(s.metrics!.recall.worst, 1);
    assert.deepEqual(s.problemHitRate[0]!.found, { num: 1, den: 1, value: 1 });
    assert.equal(s.worstMeetsAllTargets, true);
  });

  it('scores and flags runs the agent cut short, including aborted ones', () => {
    const s = summarizeRuns(
      [run(1, 'max_turns', perfect.slice(0, 1), 'reached the 25-turn cap'), run(2, 'aborted', perfect.slice(0, 2))],
      TRUTH,
      3,
    );
    assert.equal(s.requested, 3);
    assert.equal(s.started, 2);
    assert.equal(s.completed, 0);
    assert.equal(s.scored, 2);
    assert.deepEqual(
      s.flagged.map((f) => f.stopReason),
      ['max_turns', 'aborted'],
    );
    assert.equal(s.metrics!.recall.worst, 0.25);
  });

  it('sums found-but-unpriced problems and unpriced estimates above range over scored runs', () => {
    const wide: GroundTruth = {
      ...TRUTH,
      findings: TRUTH.findings.map((p) => ({ ...p, resource_ids: [`${p.id}1`, `${p.id}2`, `${p.id}3`] })),
    };
    const r = (n: number, stop: RunStop, fs: Finding[]): ScoredRun => ({ ...run(n, stop, []), score: scoreRun(fs, wide) });
    const s = summarizeRuns(
      [
        r(1, 'completed', [finding(['a1'], 999), finding(['b1'], 100)]),
        r(2, 'completed', [finding(['c1'], 5000)]),
        r(3, 'api_error', [finding(['d1'], 5000)]),
      ],
      wide,
      3,
    );
    assert.equal(s.foundNotPriced, 3);
    assert.equal(s.unpricedAboveRange, 2);
  });

  it('has no metrics when nothing was scored', () => {
    assert.equal(summarizeRuns([run(1, 'api_error', [], 'down')], TRUTH, 1).metrics, undefined);
    const none = summarizeRuns([], TRUTH, 3);
    assert.equal(none.started, 0);
    assert.equal(none.metrics, undefined);
    assert.equal(none.worstMeetsAllTargets, false);
  });
});

describe('exitCodeFor', () => {
  it('fails only when nothing was scoreable, unless --strict', () => {
    assert.equal(exitCodeFor(summarizeRuns([], TRUTH, 1), false), 1);
    assert.equal(exitCodeFor(summarizeRuns([run(1, 'api_error', [])], TRUTH, 1), false), 1);

    const weak = summarizeRuns([run(1, 'completed', perfect.slice(0, 1))], TRUTH, 1);
    assert.equal(exitCodeFor(weak, false), 0);
    assert.equal(exitCodeFor(weak, true), 1);

    const good = summarizeRuns([run(1, 'completed', perfect), run(2, 'api_error', [])], TRUTH, 2);
    assert.equal(exitCodeFor(good, true), 0);
  });
});
