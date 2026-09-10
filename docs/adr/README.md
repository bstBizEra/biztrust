# Architecture Decision Records

This directory is **empty on purpose**, and the reason is recorded rather than
left to be guessed at.

## Why it is empty

`badf/authority.yaml` withholds `adr_acceptance`:

> **what:** Acceptance of ADR-001 to ADR-020
> **status:** NOT_GRANTED
> **held_by:** architecture authority seat

Every ADR the P0.2 design depends on — ADR-001 (modular monolith), ADR-004
(PostgreSQL and RLS), ADR-005 (contract-first APIs), ADR-010 (durable
workflows), ADR-011 (tenant packs) — is `DRAFT_REQUIRED`. The dependency rules
this repository generates and tests are therefore the **proposal** of a design
at `IN_REVIEW`, not an accepted decision.

So the directory is not empty because nobody thought about it. It is empty
because the seat that accepts an ADR is unfilled, and an agent may not fill it.

## What belongs here, and what does not

Two decision surfaces exist in this repository and they are not
interchangeable.

| | `docs/adr/` | `badf/decision-log.jsonl` |
|---|---|---|
| Holds | architecture decisions, ADR-001 to ADR-020 | engineering and governance decisions, DEC-001 onward |
| Accepted by | the architecture authority seat | recorded by whoever made the decision, under an authority named in the record |
| May an agent write it? | **No.** Acceptance is `NOT_GRANTED`. | Yes — `badf/authority.yaml` `tool_authority.may` permits appending to the decision log. |
| Validated by | nothing yet | `scripts/validate_continuity.py`, against `schemas/decision-record.schema.json` |
| Ordering | none yet | ids unique and ascending, enforced |

The short rule: **if it decides what the architecture IS, it is an ADR and a
human accepts it. If it decides how this repository is BUILT or GOVERNED, it is
a `DEC-` record and the log already holds it.**

`DEC-002` (the seven rules are generated from the registry) is a `DEC-` record
because it decides how the rule set is produced. `ADR-001` (whether the seven
rules are the right rules at all) is an ADR because it decides the
architecture. The two are about the same seven rules and belong in different
places for that reason.

## When this directory fills

`BT-G0`, the architecture contract freeze, is `UNRECORDED`. It requires
`FOUNDATION_SEQUENCE.md` slices S01 to S11 accepted in order, and S01 alone
needs five human review seats that are unfilled. When an architecture authority
records `BT-G0`, the ADRs behind it land here.

Until then, an empty directory beside a 30-entry decision log is the honest
picture: the engineering decisions are made and recorded, and the architecture
decisions are not.

## Format

Use [ADR-FORMAT.md](../../docs/adr/ADR-FORMAT.md) if one is added, or the
conventional shape: context, decision, alternatives considered, consequences,
risks, implementation implications, validation requirements. `badf/gates.yaml`
requires the last two for `BT-G0`.
