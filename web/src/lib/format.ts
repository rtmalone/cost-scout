const dollars = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

/** Whole dollars with separators: 1255.5 → "$1,256". */
export function usd(n: number): string {
  return dollars.format(n);
}

/** Cut the middle out of a long id, keeping both ends (the prefix and the name are what identify it). */
export function shortenId(id: string, max = 22): string {
  if (id.length <= max) return id;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${id.slice(0, head)}…${id.slice(id.length - (keep - head))}`;
}

const STEPS_S = [5, 10, 15, 30, 60, 120, 300];
const MAX_TICKS = 7;

/** Axis labels in seconds, from 0 to the last multiple of the smallest step that gives at most 7 ticks. */
export function axisTicks(totalMs: number): number[] {
  const totalS = totalMs / 1000;
  const step = STEPS_S.find((s) => Math.floor(totalS / s) + 1 <= MAX_TICKS) ?? STEPS_S[STEPS_S.length - 1]!;
  const ticks: number[] = [];
  for (let t = 0; t <= totalS; t += step) ticks.push(t);
  return ticks;
}
