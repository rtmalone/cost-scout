/**
 * Scores agent runs against evals/ground-truth.json. Also yours to build.
 *
 * Usage: pnpm eval [--runs 3]
 *
 * Suggested scoring (decide and document the rules; they're a design choice):
 *
 *   Match:      an agent finding matches a ground-truth finding if their
 *               resource_ids overlap. One agent finding matches at most one
 *               ground-truth finding.
 *   Recall:     matched ground-truth findings / total ground-truth findings.
 *   Precision:  agent findings that matched / total agent findings.
 *   Decoys hit: agent findings that include any decoy resource_id. Should be 0;
 *               report each one with the decoy's reason.
 *   Savings:    for each match, is the estimate within tolerance_pct of
 *               expected_monthly_savings_usd?
 *   Coverage:   for each match, what fraction of the ground-truth resource_ids
 *               did the agent include? (e.g. found 9 of 12 old snapshots)
 *
 * Run it more than once (--runs). Agents are non-deterministic, so report the
 * mean and the worst run, not just the best one.
 *
 * Output: a table per run plus a summary, and write the full results to
 * evals/results/<timestamp>.json so you can compare prompt and model changes.
 */

import 'dotenv/config';

// TODO(tyler): load ground truth, call runAgent, score, print, save.
console.error('Evals are not implemented yet. See the outline at the top of evals/run-evals.ts.');
process.exit(1);
