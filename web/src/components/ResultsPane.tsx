import type { UiStatus } from '../../../src/ui/events.ts';
import { usd } from '../lib/format.ts';
import { statusText, type RunState } from '../lib/runState.ts';
import { FindingCard } from './FindingCard.tsx';

const tokenCount = new Intl.NumberFormat('en-US');

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function EndOfRun({ state, status }: { state: RunState; status: UiStatus | null }) {
  const end = state.end;
  const u = end?.usage;
  const tokens = u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0;
  const stats = end && [
    plural(end.turns, 'turn'),
    plural(end.toolCalls, 'tool call'),
    // A run stopped from the page never hears its token count back from the server.
    ...(tokens > 0 ? [`${tokenCount.format(tokens)} tokens`] : []),
  ];
  const ok = !state.error && end?.stopReason === 'completed';
  return (
    <section className={ok ? 'end' : 'end end-early'}>
      <p className="end-status">{statusText(state, status)}</p>
      {end?.summary && <p className="end-summary">{end.summary}</p>}
      {stats && <p className="end-stats">{stats.join(' · ')}</p>}
    </section>
  );
}

export function ResultsPane({ state, status }: { state: RunState; status: UiStatus | null }) {
  const spend = state.monthlySpendUsd;
  const pct = spend > 0 ? Math.round((state.savingsUsd / spend) * 100) : 0;

  return (
    <section className="card results">
      {state.phase === 'finished' && <EndOfRun state={state} status={status} />}
      <div className="label">Proposed savings</div>
      <div className="savings">
        {usd(state.savingsUsd)}
        <span className="per">/mo</span>
      </div>
      {/* The spend query can fail (monthlySpendUsd 0): then there's nothing to compare against. */}
      {spend > 0 && (
        <>
          <p className="share">
            {pct}% of the {usd(spend)}/month this environment spends
          </p>
          <div className="gauge" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
        </>
      )}
      {state.findings.length === 0 ? (
        <p className="empty">
          {state.phase === 'running'
            ? 'Findings appear here as the agent reports them.'
            : state.phase === 'idle'
              ? 'Ask a question and the findings will appear here, each with its evidence, the change, and how to roll it back.'
              : 'No findings were reported.'}
        </p>
      ) : (
        state.findings.map((f, i) => <FindingCard key={i} finding={f} />)
      )}
    </section>
  );
}
