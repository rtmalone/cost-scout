import { useState } from 'react';
import { axisTicks } from '../lib/format.ts';
import type { CallView, TurnView } from '../lib/runState.ts';
import { InlineMarkdown, Markdown } from './Markdown.tsx';

/** The axis never spans less than this, so the first seconds of a run don't fill the width. */
const MIN_SPAN_MS = 10_000;

function pct(ms: number, spanMs: number): string {
  return `${Math.min(100, Math.max(0, (ms / spanMs) * 100))}%`;
}

function CallDetail({ call }: { call: CallView }) {
  return (
    <div className={`call-detail detail-${call.kind}`}>
      {call.sql && <pre>{call.sql}</pre>}
      <span>
        {call.result}
        {call.result && ' · '}
        {call.durationMs} ms
      </span>
    </div>
  );
}

function TurnRow({ turn, spanMs, elapsedMs }: { turn: TurnView; spanMs: number; elapsedMs: number }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const live = turn.durationMs === undefined;
  const width = live ? Math.max(0, elapsedMs - turn.startMs) : turn.durationMs!;
  const end = turn.startMs + width;
  const toggle = (id: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="turn">
      <span className="turn-n">T{turn.turn}</span>
      <div>
        <div className="track">
          <div
            className={live ? 'think live' : 'think'}
            style={{ left: pct(turn.startMs, spanMs), width: pct(width, spanMs) }}
          />
          {!live && turn.calls.length > 0 && (
            <div
              className={turn.calls.some((c) => c.kind === 'finding') ? 'tick tick-finding' : 'tick'}
              style={{ left: pct(end, spanMs) }}
            />
          )}
        </div>
        {turn.text && <Markdown className="say" text={turn.text} />}
        {turn.calls.length > 0 && (
          <div className="calls">
            {turn.calls.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`call call-${c.kind}`}
                aria-expanded={open.has(c.id)}
                onClick={() => toggle(c.id)}
              >
                <InlineMarkdown text={c.label} />
                {c.result && <span className="call-result">{c.result}</span>}
              </button>
            ))}
          </div>
        )}
        {turn.calls.filter((c) => open.has(c.id)).map((c) => (
          <CallDetail key={c.id} call={c} />
        ))}
      </div>
    </div>
  );
}

/** One row per model turn on a shared wall-clock axis: where the run's time actually goes. */
export function TimingChart({ turns, elapsedMs }: { turns: TurnView[]; elapsedMs: number }) {
  const spanMs = Math.max(elapsedMs, MIN_SPAN_MS);
  return (
    <div className="chart">
      {turns.map((t) => (
        <TurnRow key={t.turn} turn={t} spanMs={spanMs} elapsedMs={elapsedMs} />
      ))}
      <div className="axis">
        {axisTicks(spanMs).map((s) => (
          <span key={s} style={{ left: pct(s * 1000, spanMs) }}>
            {s}s
          </span>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="swatch swatch-thinking" />
          Model thinking
        </span>
        <span>
          <i className="swatch swatch-query" />
          Queries
        </span>
        <span>
          <i className="swatch swatch-finding" />
          Finding reported
        </span>
      </div>
    </div>
  );
}
