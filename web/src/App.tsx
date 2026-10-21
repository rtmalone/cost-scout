import { initialState, statusText } from './lib/runState.ts';

export function App() {
  return <p>{statusText(initialState, null)}</p>;
}
