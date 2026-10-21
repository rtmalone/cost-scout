import { QuestionCard } from './components/QuestionCard.tsx';
import { ResultsPane } from './components/ResultsPane.tsx';
import { useRun } from './useRun.ts';

export function App() {
  const { state, status, start, stop } = useRun();
  return (
    <main className="layout">
      <div className="column">
        <QuestionCard running={state.phase === 'running'} status={status} onStart={start} onStop={stop} />
        {/* Task 6: the work card (status line and timing chart) goes here. */}
      </div>
      <ResultsPane state={state} status={status} />
    </main>
  );
}
