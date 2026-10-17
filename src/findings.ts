/**
 * The shape of a finding — the agent's only output. Shared by the tool layer
 * (which validates findings), the CLI (which prints them), and the evals
 * (which score them against ground truth).
 */

export const FINDING_CATEGORIES = [
  'idle-compute',
  'unattached-storage',
  'stale-snapshot',
  'oversized-function',
  'storage-modernization',
  'schedule-non-prod',
  'cost-anomaly',
  'other',
] as const;

export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface Finding {
  title: string;
  category: FindingCategory;
  resource_ids: string[];
  /** The query results that justify the finding, in plain language. */
  evidence: string;
  estimated_monthly_savings_usd: number;
  /** What to change: CLI command, IaC diff, or console steps. Never executed by the agent. */
  proposed_change: string;
  /** How to undo the change if it turns out to be wrong. */
  rollback: string;
  risk: RiskLevel;
  /** Who should approve, and what they should confirm first. */
  approval_notes: string;
}
