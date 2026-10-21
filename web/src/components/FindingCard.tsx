import { useState } from 'react';
import type { Finding } from '../../../src/findings.ts';
import { shortenId, usd } from '../lib/format.ts';

const PREVIEW_MAX = 140;

const TABS = [
  { key: 'change', label: 'Change', text: (f: Finding) => f.proposed_change },
  { key: 'evidence', label: 'Evidence', text: (f: Finding) => f.evidence },
  { key: 'rollback', label: 'Rollback', text: (f: Finding) => f.rollback },
  { key: 'approval', label: 'Approval', text: (f: Finding) => f.approval_notes },
] as const;

type TabKey = (typeof TABS)[number]['key'];

const RISK_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' } as const;

/** The evidence up to its first sentence break, or the first 140 characters. */
function preview(evidence: string): string {
  const stop = evidence.indexOf('. ');
  if (stop >= 0 && stop + 1 <= PREVIEW_MAX) return evidence.slice(0, stop + 1);
  return evidence.length > PREVIEW_MAX ? `${evidence.slice(0, PREVIEW_MAX).trimEnd()}…` : evidence;
}

/** One reported finding. Every field is model-written, so it renders as plain text. */
export function FindingCard({ finding }: { finding: Finding }) {
  const [tab, setTab] = useState<TabKey>('change');
  const active = TABS.find((t) => t.key === tab)!;

  return (
    <article className="finding">
      <div className="finding-top">
        <h3 className="finding-title">{finding.title}</h3>
        <span className="finding-savings">{usd(finding.estimated_monthly_savings_usd)}/mo</span>
      </div>
      <p className="finding-preview">{preview(finding.evidence)}</p>
      <div className="tags">
        <span className={`tag risk risk-${finding.risk}`}>{RISK_LABEL[finding.risk]}</span>
        {finding.resource_ids.map((id) => (
          <span key={id} className="tag" title={id}>
            {shortenId(id)}
          </span>
        ))}
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={t.key === tab}
            className={t.key === tab ? 'tab on' : 'tab'}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="tab-body" role="tabpanel">
        {active.text(finding)}
      </p>
    </article>
  );
}
