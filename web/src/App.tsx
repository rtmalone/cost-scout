import { QuestionCard } from './components/QuestionCard.tsx';
import { ResultsPane } from './components/ResultsPane.tsx';
import { WorkCard } from './components/WorkCard.tsx';
import { useRun } from './useRun.ts';

export function App() {
  const { state, status, start, stop, nowMs } = useRun();
  return (
    <main className="layout">
      <div className="column">
        <QuestionCard running={state.phase === 'running'} status={status} onStart={start} onStop={stop} />
        <WorkCard state={state} status={status} nowMs={nowMs} />
      </div>
      <ResultsPane state={state} status={status} />
    </main>
  );
}
