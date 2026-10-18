# DEVLOG

What went wrong while building cost-scout, how each problem was caught, and what I decided. I built the project agent-first: I wrote the plan, an implementer agent built each phase, and a separate reviewer agent (Sonnet) checked its work before anything was committed. Two kinds of agent show up below: the **coding agents** that built the project, and the **cost agent** the project is about.

The pattern across most entries: confident output, whether from an agent, a reviewer or me, is a hypothesis until something checks it.

---

## The answer key leaked through the finding categories

**What happened:** the `report_finding` schema offered categories like `idle-compute`, `stale-snapshot`, `schedule-non-prod` and `cost-anomaly`. Seven of the eight mapped almost one-to-one onto the planted problems. The schema is sent to the model on the first turn, so the cost agent was told what to look for before it had run a single query. The error was in the original scaffold.

**How it was caught:** the reviewer agent's first pass marked it as a blocker.

**Decision:** I switched to coarse service areas (`compute`, `storage`, `network`, `database`, `other`). Matching is by resource ID, so the category is informational only.

## The system prompt read like a checklist of the scenario

**What happened:** the investigation guidance listed detectors such as "business hours vs. off hours", "recent weeks vs. baseline", "attached or orphaned" and "allocated vs. used". Each one lined up with a specific planted problem or decoy.

**How it was caught:** the same review.

**Decision:** I rewrote it as general principles for an unknown account:

- find where the money goes;
- join cost with utilization before judging anything;
- consider change over time;
- look for evidence that a cost is justified;
- judge age against the analysis date.

I didn't strip it bare. These are real FinOps heuristics, and the scenario was built from common waste patterns, so some overlap is unavoidable. A held-out second scenario that the prompt is never tuned on is the planned test of whether it generalizes.

## An unverified claim was written into the code as fact

**What happened:** the implementer agent wrote that Sonnet 5.5 defaults to adaptive thinking and rejects `{ type: 'disabled' }`, and put that in a doc comment and in PLAN.md. Nothing verified it, and the SDK's own type docs describe `between_tools` as "thinking turned off", which contradicts it.

**How it was caught:** it sounded wrong to me, so I sent it to the reviewer specifically. The reviewer could confirm what the SDK types accept, but couldn't confirm anything about model behaviour.

**Decision:** the comment now states only what the installed types support. Model defaults are marked unverified, with a pointer to `client.models.retrieve` or a live call. The implementer acknowledged the claim was unverified.

## Parallel tool calls broke the query timeout

**What happened:** all queries shared one DuckDB connection, and `interrupt()` cancels whatever is running on that connection. When the cost agent ran queries in parallel, one query's timeout cancelled a different query. In a test, a query capped at 200 ms ran for 91 seconds.

**How it was caught:** the implementer found it while testing parallel tool calls.

**Decision:** each query now opens its own connection on the read-only, locked instance. The first regression test depended on timing, which the reviewer flagged. The replacement test is deterministic: it failed 3 out of 3 times against the old code and passed 3 out of 3 with the fix.

## The dataset used a column FOCUS no longer has

**What happened:** I modelled the billing table on FOCUS from memory, and it included `ProviderName`. When I checked the current spec (1.4), that column had been replaced by `ServiceProviderName` and `HostProviderName`.

**How it was caught:** I asked for research to back up my explanation of FOCUS and CUR, and the column check turned it up.

**Decision:** I renamed the column and labelled the data as a FOCUS 1.4 subset. It also became a design point: AWS exports FOCUS 1.0 and 1.2 while the spec is at 1.4, so a production pipeline needs a mapping layer per provider and version.

## The matching rule drifted from what I approved

**What happened:** I approved "one finding can match several planted problems if it includes all of their resources." The brief that went to the implementer said plain overlap instead, and PLAN.md was rewritten to match. The relay was where it went wrong.

**How it was caught:** it was surfaced before review. The reviewer then showed that plain overlap has a real loophole: one sloppy finding that names a single resource from each of four problems merges them into one savings unit. Savings accuracy then reads 100% while recall is 50%.

**Decision:** a hybrid rule.

- **Found** means any overlap.
- **Fully found** means at least half the resources were named.
- A finding is **priced** against a problem only if it alone names at least half of it.
- Findings that end up unpriced still have their estimates listed and flagged when above range, so a vague finding can't hide an inflated number.

## Safer fixes versus savings accuracy

**What happened:** on the first live run, two savings estimates fell below the expected range. In both cases the cost agent chose a more cautious fix (downsize instead of stop, archive before delete) and named the full saving as the alternative. The 3-run eval showed the same pattern: 9 conservative estimates and zero overestimates, which put savings accuracy at 63% against a 75% target.

**Decision:** I kept the metric strict and gave conservative estimates a human review rather than counting them as accurate. The scorecard lists each one with its proposed change. For a cost tool, overstating savings is the dangerous error, and that never happened. I'd rather the scorecard show the tension honestly than redefine the metric until it passes.

## Not tuning the prompt to chase a miss

**What happened:** on the first live run, the cost agent saw the oversized Lambda and left it out on purpose, as low-value (about $58 a month) and risky to change. It was the only planted problem it missed.

**Decision:** I counted it as a miss and didn't change the prompt to catch it. A line added only because I knew the answer key would be teaching to the test. In the 3-run eval, with no prompt change, it found the Lambda 3 out of 3 times. The first run's miss was variance, not a gap in the prompt.

## The eval flagged a finding the answer key didn't anticipate

**What happened:** in one run, the cost agent recommended Savings Plans or Reserved Instances for steady 24/7 production compute and RDS. Nothing in the answer key matched it, so it counted as a false finding (precision 89% for that run).

**Decision:** I left the score as it is. It's a legitimate FinOps recommendation; the synthetic scenario just has no discount pricing. Here the key was incomplete, not the agent wrong, and telling those two apart is part of maintaining an eval. If I extend the scenario, commitment coverage is the first thing to add.

## The eval harness itself had bugs

**What happened:** the reviewer found three problems in the harness's first version.

- After Ctrl-C, runs that never started were scored as zeros and pulled down the averages. One interrupted 3-run eval would say FAIL on everything.
- Results were saved only after all runs finished, so a crash would lose every paid run.
- A finding below the pricing threshold could carry any savings estimate without it ever being checked.

**Decision:**

- Infrastructure failures are now listed, not averaged in.
- Ctrl-C stops new runs.
- Results save after every run.
- Unpriced estimates are checked against the expected range.

The scoring logic is pure and unit-tested, including a test that replays the first live run.
