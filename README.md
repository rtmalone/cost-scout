# cost-scout

An agent that analyzes cloud billing data, finds cost waste, and proposes fixes, each with evidence, a rollback plan, and a risk level. It **never changes anything**. It can look and propose; a human approves and executes.

See [PLAN.md](PLAN.md) for scope, status, eval targets, and design decisions.

## How it works

```
question ──▶ agent loop (Claude, tool use)
               │
               ├─ describe_schema   what data exists
               ├─ run_sql           read-only DuckDB queries over FOCUS billing + utilization
               └─ report_finding    structured finding: evidence, savings, change, rollback, risk
                                       │
                                       ▼
                               findings for human review
```

**Data.** Three tables in DuckDB (also exported as Parquet):

| Table              | What it is                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing`          | Daily cost and usage using a subset of [FOCUS 1.4](https://focus.finops.org/focus-specification/) columns, the FinOps Foundation's open billing standard that covers both AWS and Azure |
| `resources`        | Inventory: configuration and tags for every resource                                                                                                |
| `resource_metrics` | Daily utilization (CPU, network, IOPS, Lambda memory), like CloudWatch or Azure Monitor                                                             |

Billing alone can't tell you a resource is idle, so the agent has to join cost with utilization, the same way it would in a real environment.

The dataset is synthetic and deterministic: 38 resources across two AWS accounts and one Azure subscription over 90 days. It has **8 planted problems** (about $2,340/month) and **5 decoys**: resources that look wasteful but aren't, like a network-bound Kafka broker with 4% CPU, or a large Lambda that really uses its memory. The decoys test whether the agent checks before it accuses.

## Safety model

The agent runs against data it can only read, enforced in layers:

1. The database is opened in **read-only mode**.
2. **External file access is disabled** and the configuration is locked, so a query can't read local files or turn the settings back on.
3. Each call must be **exactly one statement, and it must be a SELECT**, checked with DuckDB's own parser rather than a regex.
4. Results are **capped** by rows and size, and slow queries are **cancelled**.
5. `report_finding` **rejects resource IDs that don't exist**, which catches a common agent failure: confidently citing something it made up.

All of this is covered by tests (`pnpm test`).

## Run it

```bash
pnpm install
cp .env.example .env        # add ANTHROPIC_API_KEY
pnpm generate               # build the dataset and the eval answer key
pnpm test                   # guardrail tests
pnpm scout                  # run the agent
pnpm eval                   # score it against the planted problems
```

## Evals

`pnpm eval --runs 3` runs the agent three times and scores each run against the answer key (`evals/ground-truth.json`). The agent never sees the answer key. Scoring rules are in [`evals/score.ts`](evals/score.ts):

- **Match:** a finding matches a planted problem if they share a resource ID. One finding can cover several planted problems (grouping by cause and fix earns credit for each), and several findings can split one.
- **Recall:** planted problems matched by any finding / 8. **Fully found:** problems whose matching findings together cover at least half of their resources; reported next to recall, no target.
- **Precision:** findings that match a planted problem / all findings.
- **Decoys flagged:** findings that include a decoy resource, even if they also match a real problem. Each is listed with why the decoy is fine.
- **Savings accuracy:** a finding is priced against a planted problem only when it alone covers at least half of that problem's resources. Findings and problems linked that way form one unit, whose summed estimate is compared with its summed expected savings, within tolerance. Estimates below the range are listed as **conservative** with their proposed change, for a human to judge whether the agent chose a safer fix. They aren't failures, but they don't count as accurate either. Overestimates are failures. A problem found only through a thin overlap is shown as "found, not priced". Estimates from findings that aren't priced still get listed against the expected range of the problems they touch, and are flagged when above it, so they can't slip through unchecked.
- **Coverage:** share of a planted problem's resources the agent included. Reported, no target.

The matching rule was revised from an earlier "a finding must include all of a problem's resources" version: that marked partial finds as misses, while plain overlap alone let one sloppy finding chain unrelated problems into a single, easy-to-hit savings total. Overlap now decides *found*; the 50% rule decides *fully found* and what gets priced together.

Agents are non-deterministic, so the scorecard shows the mean **and the worst run** against each target, plus how often each planted problem was found. Runs that fail for infrastructure reasons (API errors, crashes) are listed but left out of the metrics; runs the agent cut short are scored and flagged. Results are saved to `evals/results/` after every run, tagged with hashes of the prompt and the answer key.

Exit code: 1 if no run could be scored; `pnpm eval --strict` also exits 1 if the worst run misses any target. Otherwise 0.

| Metric           | Mean | Worst run | Target   |
| ---------------- | ---- | --------- | -------- |
| Recall           | TBD  | TBD       | ≥ 7/8    |
| Fully found      | TBD  | TBD       | reported |
| Precision        | TBD  | TBD       | ≥ 85%    |
| Decoys flagged   | TBD  | TBD       | 0        |
| Savings accuracy | TBD  | TBD       | ≥ 75%    |

<!-- TODO: paste the 3-run scorecard from `pnpm eval --runs 3` (model, prompt hash, date). -->

## What I'd build next

- **Real data:** AWS CUR 2.0 exported to S3 and queried with Athena; Azure cost exports through the same FOCUS schema.
- **Deploy on AWS with CDK:** the agent on Lambda or Fargate, findings in Postgres, run state in DynamoDB, and a Next.js review UI on S3 and CloudFront.
- **Cross-account access:** a read-only IAM role assumed into each customer account for discovery, and a separate, tightly scoped role used only for approved changes.
- **Human-in-the-loop execution:** approve a finding, apply the change through IaC, check that the savings actually show up, and roll back if they don't.
- **Observability:** an OpenTelemetry span for every tool call, so a run can be traced and audited from question to finding.

## Built agent-first

<!-- TODO: link DEVLOG.md: what the agent got wrong along the way and how it was caught -->
