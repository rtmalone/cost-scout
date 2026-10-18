# cost-scout — Plan

## Goal

Build a small agent that does the core loop of cloud cost optimization: **discover** waste in billing and utilization data, **explain** it with evidence, and **propose** a fix with a rollback plan and a risk level. A human approves and executes. The agent never changes anything.

The point is to show the shape of the problem done well, not breadth: safe tool design, evidence-backed findings, and evals that measure whether the agent is right.

## Non-goals (for now)

- Executing changes. The agent proposes; a human approves and applies.
- Real cloud accounts. The data is synthetic so it's reproducible and the evals have ground truth.
- A UI. The CLI is the interface until the agent and evals are solid.
- Cloud deployment. See [Later](#later-production-shape).

## Status

| Phase         | Scope                                                | Status      |
| ------------- | ---------------------------------------------------- | ----------- |
| 0. Foundation | Dataset, read-only SQL tools, guardrail tests        | ✅ Done     |
| 1. Agent loop | Tool-use loop, system prompt, audit logging          | ✅ Done     |
| 2. Evals      | Score runs against ground truth, compare across runs | 🟡 Built; held-out scenario open |
| 3. Write-up   | README results, DEVLOG of agent mistakes             | ⬜          |
| 4. CI         | GitHub Actions: typecheck and tests on every push    | ⬜ Optional |

## Phase 0: Foundation ✅

- Synthetic FOCUS billing data: 38 resources across AWS (prod, dev) and Azure, 90 days, deterministic seed.
- Three tables: `billing` (FOCUS), `resources` (inventory), `resource_metrics` (daily utilization).
- 8 planted problems (~$2,340/month) and 5 decoys, defined in `src/data/scenario.ts`. Ground truth is generated from the same specs.
- Tools: `describe_schema`, `run_sql`, `report_finding`.
- Guardrails, with 16 tests: read-only database, no file access, a single SELECT checked by DuckDB's own parser, row/size/time limits, and hallucinated resource IDs rejected. Each query gets its own connection, so a timeout in one parallel tool call can't cancel another.

## Phase 1: Agent loop

**Build:** `src/agent/run.ts`, tested in `test/agent.test.ts` with a fake client (no network, no API key)

- [x] Tool-use loop on the Anthropic SDK: call the model, run the tool calls in parallel, send all the results back in one message in order, repeat until done. Hand-written rather than the SDK's beta `toolRunner`, for the budget, audit and stop-reason control below.
- [x] Stop conditions: the model finishes, a turn cap (default 25), a token budget (default 1M tokens across turns), or an `AbortSignal` (Ctrl-C in the CLI). Every limit ends gracefully with the findings so far and a `stopReason`.
- [x] Every `stop_reason` handled on purpose: `tool_use` runs tools; `max_tokens` runs the complete tool calls and answers a cut-off final call with an error instead of running it; `pause_turn` resumes; `refusal` and `model_context_window_exceeded` stop without running that turn's tools; API errors (after SDK retries) stop with `api_error`.
- [x] System prompt covering:
  - **How to investigate:** schema first; aggregate in SQL; find where the money goes; join cost with utilization and configuration before judging anything; consider change over time, not just averages; look for evidence a cost is justified and leave out mixed cases; judge age against the analysis date.
  - **What counts as evidence:** specific numbers from queries, not assumptions.
  - **How to price savings:** `EffectiveCost`, a 30-day month, and the stated assumptions.
  - **Grouping:** one finding per root cause and fix, not one per resource.
  - **Safety:** state the risk, the rollback, and who should approve.
  - General guidance for an unknown account, not a list of waste patterns. The scenario was built from common FinOps waste patterns, so some overlap with any competent guidance is unavoidable; a held-out second scenario (Phase 2) will test whether the prompt generalizes.
- [x] Prompt caching on the system prompt and tool definitions (one breakpoint on the system block covers both), plus automatic caching of the growing conversation. History is append-only.
- [x] Log every tool call (name, input including SQL and purpose, row count or error, duration) via `onToolCall` and in `AgentResult.toolCalls`. Usage sums input, output, cache-read and cache-write tokens.
- [x] Thinking and effort are optional pass-throughs, not sent by default, so the model's own default applies. The SDK types accept `enabled`, `disabled`, `between_tools` and `adaptive`; which a given model accepts, and its default, are unverified (check `client.models.retrieve(model)` capabilities or a live call). Thinking blocks are passed back unchanged.
- [x] Live run: `pnpm scout` against the API. First run: completed in 7 turns and 17 tool calls; 6 findings covering 7 of 8 planted problems, 0 decoys flagged, 0 false findings. About 126k tokens, mostly cache reads (31k cache write on turn 1, 84k cache read), so caching works and the 1M budget is far off.

**Done when:** `pnpm scout` produces findings with evidence, a change, a rollback and a risk level.

## Phase 2: Evals

**Build:** `evals/score.ts` (pure scoring, tested in `test/score.test.ts`), `evals/summary.ts` (aggregation across runs, tested in `test/summary.test.ts`) and `evals/run-evals.ts` (the CLI)

| Metric           | Definition                                                     | Target              |
| ---------------- | -------------------------------------------------------------- | ------------------- |
| Recall           | Planted problems found / 8                                     | ≥ 7 of 8            |
| Precision        | Agent findings that match a planted problem / all findings     | ≥ 85%               |
| Decoys flagged   | Findings that include a decoy resource                         | 0                   |
| Savings accuracy | Matched findings whose estimate is within the tolerance        | ≥ 75%               |
| Coverage         | Share of a planted problem's resources that the agent included | Reported, no target |

- [x] **Matching (hybrid):** a planted problem is *found* if any finding shares a resource ID with it (recall), and *fully found* if the matching findings together cover at least 50% of its resources (reported alongside recall, no target). One finding can match several planted problems, and several findings can split one. Grouping by shared cause and fix is what the prompt asks for. (First live run: the agent grouped the unattached AWS volumes and the Azure disk into one finding.) This replaced an earlier "must include all of its resources" rule, which marked partial finds as misses; plain overlap alone, though, let one sloppy finding chain unrelated problems into a single savings total, hence the 50% rule for pricing below.
- [x] **Savings:** a finding is priced against a planted problem only if that finding alone covers at least 50% of the problem's resources. Units are connected components of those edges: summed estimates vs summed expected savings, at the unit's largest tolerance, so a grouped or split finding is counted once. A problem found only through thin overlaps is reported as "found, not priced"; units of 3+ problems are flagged as merged; a non-finite estimate is an overestimate. Keep the tolerance check strict, but report misses where the agent chose a safer fix (e.g. downsize instead of stop, archive before delete) as a separate "conservative estimate" category, not as failures. The scorecard stays honest and explains itself.
- [x] **No tuning to the answer key:** a planted problem the agent leaves out by judgment counts as a miss, and the prompt isn't changed just to catch it. Only make prompt changes that would be justified without the answer key; the held-out scenario checks this. (First live run: the agent left out the oversized Lambda as low-value and risky.)
- [x] `--runs N` (plus `--model`, `--concurrency`, `--strict`): report the mean and the worst run, because agents are non-deterministic. Per planted problem, the hit rate across runs. Infrastructure failures (API errors, crashes) are listed but left out of the metrics; runs the agent cut short or that were aborted are scored and flagged. Exit 1 when no run is scoreable, and with `--strict` also when the worst run misses a target.
- [x] Save results to `evals/results/` (gitignored) after every run, to compare prompt and model changes, tagged with a hash of the system prompt, tool definitions and question, plus a hash of the answer key.
- [x] Smoke test, 1 run (before the hybrid rule; it scores the same under it): recall 7/8 (missed gp2-to-gp3, found the Lambda this time), precision 6/6, 0 decoys, savings 5/6 within (idle-ec2 conservative: downsize instead of stop). About 149k tokens.
- [ ] Held-out second scenario (different waste and decoys) to check the prompt generalizes.

**Done when:** one command produces a scorecard that can go in the README.

## Phase 3: Write-up

- [ ] README: eval results and a sample finding.
- [ ] `DEVLOG.md`: what the agent got wrong and how it was caught or fixed, e.g. a decoy it flagged, a pattern it missed, bad savings math. Each fix should be a prompt or tool change, with a before/after eval score.

## Phase 4: CI (optional)

- [ ] GitHub Actions: install, `pnpm generate`, `pnpm typecheck`, `pnpm test`.
- [ ] Evals stay manual (they cost API calls). They can be added as a manual or nightly job later.

## Key decisions

| Decision                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FOCUS format instead of raw AWS CUR                            | One open schema for AWS and Azure. Multi-cloud from day one.                                                                                                                                                                                                                                                                                                                            |
| Target the latest FOCUS spec (1.4), and plan for version drift | Providers lag the spec: AWS Data Exports offers FOCUS 1.0 and 1.2, while the spec is at 1.4, and columns change between versions (e.g. `ProviderName` became `ServiceProviderName` and `HostProviderName` in 1.3). The agent queries one normalized schema. In production, a thin mapping layer per provider and version keeps the agent's SQL and prompts unchanged as exports change. |
| Synthetic data with planted problems                           | Reproducible, and gives the evals ground truth. Real data has no answer key.                                                                                                                                                                                                                                                                                                            |
| Decoys alongside the waste                                     | Recall alone rewards an agent that flags everything. Decoys measure whether it checks before it accuses.                                                                                                                                                                                                                                                                                |
| DuckDB, read-only                                              | Fast local analytics with the same SQL shape as Athena, and safety enforced by the engine, not the prompt.                                                                                                                                                                                                                                                                              |
| No tool that executes changes                                  | Safety by construction: the agent can't do what it has no tool for.                                                                                                                                                                                                                                                                                                                     |
| Sonnet 5.5 as the default model | The task is bounded: three tools, structured data, clear pricing rules, a fixed output format, about 7 turns per run. The first live run handled the judgment calls (7 of 8 found, 0 decoys, 0 false findings), so there's no evidence yet that a larger model's extra cost is justified. Check with `pnpm eval --model claude-opus-5-5`, and revisit if the evals show a gap. |
| Findings require a rollback and a risk level                   | Forces the agent to reason about what could go wrong, not just what to delete.                                                                                                                                                                                                                                                                                                          |

## Risks

| Risk                                         | Mitigation                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Agent flags decoys (e.g. low CPU means idle) | The prompt requires checking utilization; decoys are scored separately.                            |
| Savings math drifts                          | Pricing rules in the prompt; tolerance-based scoring.                                              |
| Large results blow up the context window     | Row and size caps; the prompt says to aggregate in SQL.                                            |
| Eval scores vary between runs                | Multiple runs, reporting the mean and the worst.                                                   |
| Synthetic data is too easy                   | Some problems only show in time patterns (dev schedules, the NAT spike), not in simple thresholds. |

## Later: production shape

Not in scope now, but the path from here:

1. **Real data:** CUR 2.0 exported to S3 and queried with Athena; Azure cost exports in FOCUS. Same SQL, different engine.
2. **Deploy with CDK:** the agent on Lambda or Fargate, findings in Postgres, run state in DynamoDB, a Next.js review UI on S3 and CloudFront.
3. **Cross-account access:** a read-only role for discovery, and a separate, tightly scoped role used only for approved changes.
4. **Approval and execution:** approve → apply through IaC → check that the savings actually show up → roll back if they don't.
5. **Observability:** an OpenTelemetry span for every tool call and every run, plus alerts on failed runs and on large deltas between estimated and actual savings.

## References

- [FOCUS specification](https://focus.finops.org/focus-specification/): v1.4, ratified June 2026. The dataset uses a subset of its Cost and Usage columns.
- [AWS: Data Exports for FOCUS 1.0 is generally available](https://aws.amazon.com/blogs/aws-cloud-financial-management/data-exports-for-focus-1-0-is-now-generally-available/). AWS Data Exports now offers CUR 2.0, FOCUS 1.0 and FOCUS 1.2 tables, delivered to S3 ([FAQ](https://aws.amazon.com/cn/aws-cost-management/aws-data-exports/faqs/)).
- [Microsoft Cost Management updates, April 2025](https://azure.microsoft.com/en-us/blog/microsoft-cost-management-updates-april-2025/): enhanced exports, including a FOCUS dataset, are generally available.
