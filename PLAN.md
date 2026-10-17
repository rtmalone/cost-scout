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
| 1. Agent loop | Tool-use loop, system prompt, audit logging          | ⬜ Next     |
| 2. Evals      | Score runs against ground truth, compare across runs | ⬜          |
| 3. Write-up   | README results, DEVLOG of agent mistakes             | ⬜          |
| 4. CI         | GitHub Actions: typecheck and tests on every push    | ⬜ Optional |

## Phase 0: Foundation ✅

- Synthetic FOCUS billing data: 38 resources across AWS (prod, dev) and Azure, 90 days, deterministic seed.
- Three tables: `billing` (FOCUS), `resources` (inventory), `resource_metrics` (daily utilization).
- 8 planted problems (~$2,340/month) and 5 decoys, defined in `src/data/scenario.ts`. Ground truth is generated from the same specs.
- Tools: `describe_schema`, `run_sql`, `report_finding`.
- Guardrails, with 15 tests: read-only database, no file access, a single SELECT checked by DuckDB's own parser, row/size/time limits, and hallucinated resource IDs rejected.

## Phase 1: Agent loop

**Build:** `src/agent/run.ts`

- [ ] Tool-use loop on the Anthropic SDK (pattern from Cortex): call the model, run the tool calls in parallel, send the results back, repeat until done.
- [ ] Stop conditions: the model finishes, a turn cap (default 25), or a token budget.
- [ ] System prompt covering:
  - **How to investigate:** schema first; aggregate in SQL; check utilization before calling anything idle; look at time patterns (business hours vs. off hours, recent vs. baseline).
  - **What counts as evidence:** specific numbers from queries, not assumptions.
  - **How to price savings:** `EffectiveCost`, a 30-day month, and the stated assumptions.
  - **Grouping:** one finding per root cause and fix, not one per resource.
  - **Safety:** state the risk, the rollback, and who should approve.
- [ ] Prompt caching on the system prompt and tool definitions.
- [ ] Log every tool call (SQL, purpose, row count, errors) so a run can be audited.

**Done when:** `pnpm scout` produces findings with evidence, a change, a rollback and a risk level.

## Phase 2: Evals

**Build:** `evals/run-evals.ts`

| Metric           | Definition                                                     | Target              |
| ---------------- | -------------------------------------------------------------- | ------------------- |
| Recall           | Planted problems found / 8                                     | ≥ 7 of 8            |
| Precision        | Agent findings that match a planted problem / all findings     | ≥ 85%               |
| Decoys flagged   | Findings that include a decoy resource                         | 0                   |
| Savings accuracy | Matched findings whose estimate is within the tolerance        | ≥ 75%               |
| Coverage         | Share of a planted problem's resources that the agent included | Reported, no target |

- [ ] A match is any resource-ID overlap; each agent finding matches at most one planted problem.
- [ ] `--runs N`: report the mean and the worst run, because agents are non-deterministic.
- [ ] Save each run to `evals/results/` to compare prompt and model changes.

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
