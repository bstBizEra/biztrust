# Knowledge policy

Knowledge is dated, scoped evidence. Knowledge is not permission. A fact that
has been true for a long time still grants no authority.

## Where a fact lives, and what moves it

| Level | Home | What it takes to promote |
|---|---|---|
| Session | The current task and its notes | Recheck it before relying on it later |
| Package | The active Work Package and its checkpoint | A reproducible finding with a future use |
| Project | The architecture, domain and operations documents here | Verified evidence, provenance, a review, an owner and an invalidation trigger |
| Cross-project | A separately authorized destination | Check that it transfers. Remove project data. Another project's authority does not come with it. |
| Policy | `AGENTS.md` or an approved policy source | Explicit policy-change authority, and a review |

The order is: observation, then verified lesson, then candidate guidance, then
reviewed knowledge, then authorized policy. Verification may disprove the
observation. Record the correction.

**Never promote a workaround into a rule because it worked.** Repetition is not
evidence, and an agent may not infer authority from its own success.

## Recording a lesson

A lesson records the observed problem, how confident the cause is, the
candidate and environment, the evidence, the limits, the reusable response, an
owner and a trigger to revisit it.

When no reusable lesson is supported, write that. Inventing a lesson to fill
the step is waste and it pollutes the index.

## Decisions

A decision records its context, the alternatives, the evidence, the reason, the
accountable owner, the date, the scope and a revisit trigger.

Platform decisions go to `badf/decision-log.jsonl`. Architecture decisions are
ADRs, and they live in the guide repository. Do not reopen a settled decision
without new evidence.

## Disagreement

For a material disagreement, record the claim, its source and date, the
reproduction, the counter-evidence, who resolves it, and the disposition:
`verified`, `refuted`, `unresolved` or `stale`.

State confidence as high, medium, low or unknown, with a reason. Confidence is
not a probability and it is not an acceptance.

Preserve an unresolved conflict. Do not settle it by agreement between agents.

## What never enters this repository

Secrets, credentials, client records, policy records, claim records, premium
figures and raw sensitive logs. Synthetic data only. The validator scans for
credential shapes on every run, and a tenant name anywhere in the tree is a
review finding.
