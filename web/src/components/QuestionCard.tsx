import { useState } from 'react';
import type { UiStatus } from '../../../src/ui/events.ts';

const EXAMPLES = [
  'Find the biggest cost-saving opportunities',
  'Which storage costs could we cut?',
  'Is anything in the Azure subscription idle?',
  'Are any Lambda functions over-provisioned?',
];

export function QuestionCard({
  running,
  status,
  onStart,
  onStop,
}: {
  running: boolean;
  status: UiStatus | null;
  onStart(question: string): void;
  onStop(): void;
}) {
  const [question, setQuestion] = useState('');
  const notReady = status !== null && !status.ready;

  return (
    <form
      className="card question"
      onSubmit={(e) => {
        e.preventDefault();
        if (running) onStop();
        else if (!notReady) onStart(question.trim());
      }}
    >
      <label className="label" htmlFor="question">
        What should cost-scout look into?
      </label>
      <textarea
        id="question"
        rows={2}
        value={question}
        disabled={running}
        placeholder="Find the biggest cost-saving opportunities"
        onChange={(e) => setQuestion(e.target.value)}
      />
      <p className="scope">
        <b>Good questions</b> are about spend, waste or utilization in this environment (38 resources,
        AWS and Azure, 90 days). It reads the data and proposes fixes; it can't change anything.
      </p>
      <div className="pills">
        {EXAMPLES.map((q) => (
          <button key={q} type="button" className="pill" disabled={running} onClick={() => setQuestion(q)}>
            {q}
          </button>
        ))}
      </div>
      <button type="submit" className={running ? 'go stop' : 'go'} disabled={!running && notReady}>
        {running ? 'Stop' : 'Investigate'}
      </button>
      {notReady && status.problems.map((p) => <p key={p} className="problem">{p}</p>)}
    </form>
  );
}
