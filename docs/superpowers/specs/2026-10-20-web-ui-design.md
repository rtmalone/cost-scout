# cost-scout web UI: design

Date: 2026-10-20

## Intent

cost-scout is a portfolio project. Today the only way to see the agent work is `pnpm scout`, which prints tool calls and findings to the terminal. The UI is for **someone reviewing the project** (a hiring manager, a teammate) who clones the repo and wants to watch the agent investigate and read its findings without parsing terminal output.

The UI is a second way into the same agent. The CLI stays exactly as it is.

## Goals

- `pnpm ui` starts a local server and opens a page where you can:
  - type a question, with guidance on what makes a good one and clickable example questions
  - see clearly that the agent is working, and what it's doing right now
  - watch every tool call as it happens, on a timing chart
  - read the findings in a friendly, digestible form as they arrive, with the running savings total
- The look is distinctive but simple and uncluttered ("breathable"), in the Nord light palette.

## Non-goals

- **Replay or demo mode.** Every run is live, against the real API, with the reviewer's own key. (Decided: the user chose live only.)
- **Hosting or deployment.** Local only, like the CLI.
- **Run history.** Each run lives only in the page; refreshing or starting a new run clears it. _(My call.)_
- **Changing the agent's behaviour.** Same prompt, tools, limits and model selection as the CLI. Eval results must stay comparable.
- **Executing findings.** The UI never offers an "apply" action. cost-scout proposes; a human executes elsewhere.

## Anti-goals (my calls, from the project's existing stance)

- A UI that hints the agent can change things (buttons like "Fix", "Apply").
- Exposing `ANTHROPIC_API_KEY` to the browser. The key stays in the server process, read from `.env` as the CLI does.
- A generic dashboard look: boxed panels, default component-library styling.

## Constraints

- Lives in this repo, TypeScript, run with pnpm and `tsx` like the rest.
- Reuses `runAgent` (`src/agent/run.ts`) and `ReadOnlyDb` (`src/tools/db.ts`). No second copy of the loop.
- Same preconditions as the CLI, shown in the page rather than as a crash: dataset missing (`pnpm generate` first), API key missing.
- Model from `COST_SCOUT_MODEL`, default `claude-sonnet-5-5`, same as the CLI.
- Server binds to `127.0.0.1` only.
- A run takes about 90 s and about 165k tokens with Sonnet; the page must stay informative for that whole time.

## How it gets made (decided)

- **`pnpm ui`**: starts a small local Node server, which serves the page and runs the agent.
- **Streaming**: the server pushes run events to the browser as they happen.
- **Front end**: React, built with Vite.

## Layout and visual design (decided, from mockups)

Two panes, "Waterfall" style: rounded white cards floating on a Snow Storm background, soft shadows, generous spacing. Body font Manrope; monospace JetBrains Mono for IDs, timings and the clock.

### Palette: Nord light

| Role                                  | Colour                                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Page background                       | nord6 `#ECEFF4`                                                                              |
| Cards                                 | white `#FFFFFF`; inner surfaces nord6 `#ECEFF4`, chips nord5 `#E5E9F0`                       |
| Hairlines                             | nord4 `#D8DEE9`                                                                              |
| Primary text                          | nord0 `#2E3440`                                                                              |
| Secondary text, **timing-chart axis** | nord3 `#4C566A` (the axis was too light in the mockup, nord4; it must be this darker colour) |
| Primary accent (button, active tab)   | nord10 `#5E81AC`                                                                             |
| Chart: model thinking (turn bars)     | nord8 `#88C0D0`, solid; the live turn animated with stripes of the same colour               |
| Chart: queries (ticks and labels)     | nord12 `#D08770`; labels tinted with a 3px stripe of it                                      |
| Chart: finding reported               | nord14 `#A3BE8C` tick with a darker green outline; labels tinted green and bold              |
| Savings gauge                         | gradient nord7 `#8FBCBB` → nord14 `#A3BE8C`                                                  |
| Low risk                              | nord14 `#A3BE8C`                                                                             |
| Medium risk                           | nord13 `#EBCB8B`                                                                             |
| High risk, errors                     | nord11 `#BF616A`                                                                             |

The user likes the brighter Frost and Aurora accents on the light background. Use them for meaning (status, risk, category), not decoration.

### Left pane, top card: the question

- Label: "What should cost-scout look into?" and a large, borderless text area.
- A tinted note on scope: good questions are about spend, waste or utilization in this environment (38 resources, AWS and Azure, 90 days); it reads the data and proposes fixes, and can't change anything.
- Example questions as pills; clicking one fills the text area. Use the default question plus the README's examples: storage costs, idle Azure resources, over-provisioned Lambdas.
- An **Investigate** button. Empty input runs the default question, as the CLI does.
- While a run is going, the input is disabled and the button becomes **Stop**, which aborts the run gracefully (same as Ctrl-C in the CLI).

### Left pane, second card: the work

**Why the chart is built around turns.** Recorded eval runs show a median query time of about 5 ms (90th percentile 11 ms), while a run takes about 90 s. Almost all the time is spent waiting for the model's reply. A chart of tool-call durations would be invisible slivers, so the chart shows where the time actually goes. (Decided with the user after the builder check; mockup `timing-chart-v4`.)

- **Status line**: plain words for the current state ("Thinking about what to check next" while waiting on the model; how it finished at the end), with a running clock, turn number and query count.
- **Timing chart**: one row per model turn, labelled T1, T2…, on a shared wall-clock axis (seconds since the run started).
  - A solid **thinking bar** spans the model request for that turn. The turn in progress is an animated striped bar that grows with the clock.
  - At the end of the bar, a **tick** marks the tool calls the model asked for. It's orange, or green if the turn reported a finding. Ticks are 7px wide with a white halo so they read against the bar.
  - Any **text the model wrote** in that turn appears in italics under the bar.
  - Under that, one **label per tool call**, in plain English, with its result:
    - `run_sql`: its `purpose`, or the start of the SQL if there's no purpose, plus the row count
    - `describe_schema`: "Read the schema", plus the table count
    - `report_finding`: "Reported: <finding title>", plus its savings, in bold green
    - Errors (e.g. a rejected query or finding) in Aurora red `#BF616A`, with the error's first line.
  - The axis line, ticks and labels use nord3. A legend under the axis names the three colours.
- Clicking a tool-call label shows its detail: the SQL, the result summary and the duration. _(My call.)_

### Right pane: results

- **Savings total** so far, large, with "/mo". Under it, the share of the environment's total monthly spend, as a sentence ("18% of the $X/month this environment spends") and a gauge. Total monthly spend = sum of `EffectiveCost` over the last 30 days of the billing period. _(My call: whole environment, not narrowed to the question's topic.)_
- **When the run ends**: the agent's closing summary appears at the bottom of this pane, under the savings total and the finding cards, plus how it stopped. (Moved from the top at the user's request after seeing the built page.) A non-`completed` stop reason (turn cap, token budget, error, refusal, stopped by the user) is stated plainly and the findings so far stay visible.
- **Finding cards** in the order reported, appearing as each is recorded: title, savings, the first sentence or so of the evidence, a risk tag, resource ID tags (shortened in the middle when long), and tabs for **Change**, **Evidence**, **Rollback** and **Approval** showing the full text. Change is the default tab. A rejected `report_finding` (e.g. unknown resource ID) is not shown as a finding; it shows up as a red label in the chart.
- Small run stats at the bottom: turns, tool calls, tokens. _(My call.)_

The mockups are in `.superpowers` brainstorm files and aren't committed; the description above is the reference.

## Changes the agent loop needs

**The loop stays non-streaming** (decided with the user). `src/agent/run.ts` explains why it uses non-streaming requests, and changing that would rework the client seam and its tests and risk eval comparability. Each turn therefore appears in the UI when the model's full reply arrives; the clock and the animated bar keep the page alive in between.

Today `runAgent` only reports tool calls through `onToolCall`, after a turn's calls finish. The chart also needs to know when each model request starts and ends, and what text the model wrote. The builder adds optional hooks to `AgentOptions` (names and shapes up to the builder) covering:

- a model request is starting (turn number, time)
- a model reply has arrived (turn number, time, request duration, the reply's text blocks, token usage)
- the existing per-call `ToolCallRecord`, as now

These must not change behaviour for the CLI or the evals. Covered by tests in `test/agent.test.ts` with the existing fake client.

## Left to the builder

- Event transport (Server-Sent Events is the simple fit for one-way streaming) and the event shapes.
- Server framework, if any (plain `node:http` is enough).
- How `pnpm ui` serves the Vite app in development vs a built bundle; whether it opens the browser.
- Fonts: bundled (e.g. `@fontsource`) so it works offline, or Google Fonts.
- Component structure and state management.
- Behaviour at narrow widths (stack the panes).
- One run at a time per server _(my call)_; a second Investigate while one is running isn't possible because the button becomes Stop.

## Docs to update

- README "Run it": add `pnpm ui`.
- PLAN.md lists "A UI" as a non-goal "until the agent and evals are solid". Update it to record that the UI is now in scope and why.
