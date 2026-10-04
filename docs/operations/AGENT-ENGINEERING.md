# Agent engineering

This page is the reference behind `AGENTS.md` section 13. Section 13 holds the
steps. This page holds what a step reaches for, and it records what BizTrust
did not adopt from the source prompts.

It grants nothing. Authority is in `badf/authority.yaml`, and the order of
precedence is `AGENTS.md` section 2.

## Where this came from

The operator supplied seven prompts for an "Enterprise Engineer Agentic Team".
There is a master prompt, a UX and UI upgrade, and upgrades v2 to v6. They are
inputs, not policy. This page records what BizTrust took from them. Anything
not recorded here was not adopted.

## Overlap groups

Pick one method per group. Two methods from the same group give contradictory
instructions and double the context.

| Group | Installed candidates |
|---|---|
| Requirements | `brainstorming`, `grill-with-docs`, `interview-me` |
| Specification | `spec-driven-development` |
| Planning | `writing-plans`, `planning-and-task-breakdown` |
| Implementation | `subagent-driven-development`, `executing-plans`, `incremental-implementation` |
| Test-first | `test-driven-development`, `tdd` |
| Debugging | `systematic-debugging`, `diagnosing-bugs` |
| Review | `requesting-code-review`, `code-review-and-quality` |
| Simplification | `code-simplification` |
| Completion | `verification-before-completion`, `finishing-a-development-branch` |
| Security | `security-and-hardening`, `api-security`, `database-security`, `supply-chain-security` |

This table was checked against the installed `SKILL.md` files on 2026-09-29.
Installed methods change. Step 1 of section 13 searches the current files, and
this table is a starting list, not the answer.

`quality-code-review` is installed and is for Frappe applications. This
repository is not one.

## The stack

Section 13 sets the shape. A high-risk package may carry more methods, and its
self-prompt says why.

Two methods may share a stack when they do different jobs. `writing-plans`
with `api-security` is a stack. `test-driven-development` with `tdd` is two
answers to one question.

<a id="self-prompt"></a>
## The self-prompt

Before substantial work, write this contract into the Work Package checkpoint.
It turns the parent task into one role's task.

```yaml
self_prompt:
  role:            # a role id from badf/agents.yaml
  work_package:    # the one Work Package ID
  objective:       # one sentence
  in_scope:
  out_of_scope:
  stack:
    lifecycle:
    domain:
    specialists:   # zero to two
    verification:
    rejected:      # the other candidates in each group, and why
  authority:
    level:         # READ, DRAFT, PREPARE or EXECUTE
    skill_rows:    # the badf/skills.yaml ids this work exercises
  evidence:        # what will prove each claim, per AGENTS.md section 9
  stop_when:       # AGENTS.md section 11, plus any condition this task adds
  done_when:       # checkable, and exhaustive
```

A field that does not apply reads `not applicable`. An empty field reads as
unfinished.

## The authority ladder

Five words describe what an action does to the world. Section 13, step 4,
says which of them an agent may act at.

| Level | What it is |
|---|---|
| READ | Inspect files, records, history and running state |
| DRAFT | Write a proposal that changes nothing yet |
| PREPARE | Put a change on a branch and open a pull request |
| EXECUTE | Take an action that lands: a merge, a migration, a deploy |
| APPROVE | Decide that something is accepted, recorded or granted |

An operator instruction in a session can direct an EXECUTE. It is recorded as
an operator instruction, never as a seat review.

## Review, simplification and assurance

These are three jobs, and they find three different things:

1. **Review** finds defects.
2. **Simplification** removes complexity the working version does not need.
3. **Assurance** checks each claim against evidence, without the author's
   summary.

Run them in that order, then run the checks again. The version that passes
after simplification is the *second draft*, and it is the one that ships.

## Evidence ranking

When sources disagree about what the system does, rank them:

1. Running system
2. Automated tests
3. Source code
4. Configuration
5. Database schema
6. Specifications
7. ADRs
8. Project documentation
9. External documentation
10. Model memory

This ranks evidence of behavior. It does not rank authority. A running system
that does something no record allows is a finding, not a grant.

## Security testing tiers

| Tier | What | Runs under |
|---|---|---|
| 1. Static | Review, static analysis, dependency, secret and configuration scans | A Work Package |
| 2. Dynamic | Authorization, isolation and API tests against a local environment | A Work Package, on synthetic data |
| 3. Adversarial | Attack simulation, exploit validation, penetration testing | A written scope recorded in `badf/authority.yaml` |

Use the lowest tier that can prove the claim. Cross-tenant isolation, INV-003
and INV-004, is a tier 2 claim, and its negative tests belong in the package
that builds it.

A tier 3 scope names these, and without one tier 3 does not start:

- the target and its owner
- the authority
- the environment and the exclusions
- the allowed methods and the data handling
- the stop conditions and the reporting

## Council

Several agents asked to deliberate produce advice. Their agreement is not
evidence, and a council decides nothing. Record the positions and the
disagreement, then resolve it with evidence. Where evidence cannot resolve it,
it goes to the owning seat. See the
[knowledge policy](KNOWLEDGE-POLICY.md), "Disagreement".

## Gate names

The source prompts define `GATE 0` to `GATE 8`, assurance gates `A0` to `A8`
and UX gates `UX-G0` to `UX-G9`. None of them is a gate here.

The gates are the ones in `badf/gates.yaml`, and a named human role records
each one. An idea from a prompt gate enters this repository as a checklist item
in a Work Package, under its own name.

## Adding a method

Installing a plugin, a skill or an MCP server adds a dependency that tells
agents how to act. Add one through a Work Package that records its source,
version and license, and the overlap group it joins.

## Not adopted, and why

| From the prompts | Here instead |
|---|---|
| An `.agentic/` tree with router files and a skill lockfile | `badf/` is the control plane. A second one would disagree with it. |
| Context middleware (Headroom, Caveman) | None is installed. The [context policy](CONTEXT-POLICY.md) applies. |
| "Enterprise-grade" and "production-ready" as phase goals | `AGENTS.md` section 12. No such claim is possible here yet. |
| An assurance agent or orchestrator that makes the gate decision | A named human role records each gate. |
| A completion report ending in `PASS` | The outcome table in the [definition of done](DEFINITION-OF-DONE.md). |
| Method metrics, leaderboards and "specialist value" | No meter exists. Record `unavailable`, per the context policy. |
| Model routing tiers | The operator's tool configuration chooses the model. It is not repository policy. |
| The UX and UI division, its roles and gates | This repository has no application package yet. That material becomes its own Work Package when one exists. |
