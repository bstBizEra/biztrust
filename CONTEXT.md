# CONTEXT

A glossary, and nothing else. It fixes what words mean in this repository so
that two readers do not mean different things by the same one.

**`AGENTS.md` governs.** This file has no authority: it does not grant, decide,
constrain or record anything. Where it appears to disagree with `AGENTS.md`,
`badf/authority.yaml` or a `DEC-` record, those are right and this is stale.

---

## Terms that were doing two jobs

### control

A **negative-control test**: a deliberate violation that must be reported by
the rule it was built to break, plus its conforming twin that must be reported
by nothing. `control 12`, `R7-9`, `R3-1` are controls.

> A control asserts on the **message**, not the rule name. A rule with more
> than one violation shape reports the same name either way, so a name-only
> assertion stays green when the shape under test is disabled.

**Not** to be confused with a *governance control* — a policy constraint on
what an agent may do. This repository has both, and prose that says "the
control fired" has meant either. When the governance sense is intended, write
**guard**, **gate** or **refusal** instead. This entry exists because the
collision was introduced into the records by an agent and had to be corrected.

### gate

A **delivery gate**: `BT-G0` … `BT-G4` in `badf/gates.yaml`. A gate is recorded
by a **human**, never by an agent and never by a green build.

**Not** a CI step. `pnpm check:coverage` is a **check**, not a gate. A passing
check is *evidence a human reads when deciding a gate*; it is not the decision.
`AGENTS.md` §8: "a green build is not a gate result."

---

## Terms this repository uses precisely

### witness

The test that would fail if the thing it witnesses were deleted. A rule with no
witness is enforced by code and proven by nothing.

A rule can be correct, shipped, and unwitnessed at the same time — four review
rounds each found rules in exactly that state. "The suite is green" says
nothing about whether a rule works unless the rule has a witness.

### mutation

A deliberate loosening of one rule, applied by `scripts/mutation-check.mjs`,
which requires the suite to go red. Each mutation **declares** the control that
must catch it; a mutation caught by any *other* control is a failure, because
it means the declared control is not the one doing the work.

### instrument

A deterministic check whose output a human reads when deciding a gate — the
boundary check, the migration lint, the record validator, the coverage gate.
`badf/gates.yaml` names each instrument beside the gate it informs.

> "An instrument that has never been observed failing is indistinguishable from
> one that passed."

### declared non-coverage

A gap stated on purpose, with its reason, rather than left to read as an
omission. Growth in this list is a sign of honesty, not decay: it went 7 → 12 →
14 → 22 → 28 items across five review rounds, and each earlier list was honest
in tone and incomplete in fact.

### seat

A named role in `badf/agents.yaml` that decides something. A seat has an
occupant (`held_by`) and a property saying whether an agent may hold it
(`may_be_an_agent`). Four seats may never be held by an agent:
`architecture-authority`, `business-authority`, `repository-administrator`,
`legal-compliance-reviewer`.

Every `held_by` is currently `null`, and the validator pins it there: seating
someone is a change to the validator in the same pull request, which is the
cost `DEC-007` chose for authority records generally.

### Work Package

A unit of work with an id (`BIZTRUST-WP-001`), a state on the lifecycle in
`badf/lifecycle.yaml`, and a contract. A Work Package's **state** is not a gate
result and not an acceptance: it may not enter `ACCEPTED` ahead of an
acceptance record, and the validator refuses that.

### authority

Permission recorded in `badf/authority.yaml` before the work it permits.
Authority is **never inferred** — not from tool access, not from a green build,
not from an agent's own assessment. An agent may read this file and may never
widen it.

### evidence

Attributable, reproducible, and bound to a source revision. `AGENTS.md` §9
lists the required fields. A proof missing any of them is not evidence.

A claim in a docstring, a report or a CI comment is **not** evidence — three
such claims about the same behaviour were all false at once, and only building
the environment showed it. See `docs/operations/REVIEW-METHOD.md`.

---

## Two decision surfaces

| | `docs/adr/` | `badf/decision-log.jsonl` |
|---|---|---|
| Decides | what the architecture **is** | how this repository is **built** or **governed** |
| Accepted by | the architecture authority seat | recorded under a named authority; agents may append |
| Today | empty — `adr_acceptance` is `NOT_GRANTED` | `DEC-001` onward, schema-validated |

`DEC-002` (the seven rules are *generated* from the registry) and `ADR-001`
(whether those seven rules are the *right* rules) concern the same rules and
belong on opposite sides of that line. See `docs/adr/README.md`.
