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
| `billing`          | Daily cost and usage in the [FOCUS](https://focus.finops.org/) format, the FinOps Foundation's open billing standard that covers both AWS and Azure |
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

<!-- TODO: recall / precision / decoys hit / savings accuracy, across N runs -->

## What I'd build next

- **Real data:** AWS CUR 2.0 exported to S3 and queried with Athena; Azure cost exports through the same FOCUS schema.
- **Deploy on AWS with CDK:** the agent on Lambda or Fargate, findings in Postgres, run state in DynamoDB, and a Next.js review UI on S3 and CloudFront.
- **Cross-account access:** a read-only IAM role assumed into each customer account for discovery, and a separate, tightly scoped role used only for approved changes.
- **Human-in-the-loop execution:** approve a finding, apply the change through IaC, check that the savings actually show up, and roll back if they don't.
- **Observability:** an OpenTelemetry span for every tool call, so a run can be traced and audited from question to finding.

## Built agent-first

<!-- TODO: link DEVLOG.md: what the agent got wrong along the way and how it was caught -->
