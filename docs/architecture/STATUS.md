# Architecture status

The one page to read before believing anything about this repository is
implemented, decided or safe.

| Field | Value |
|---|---|
| Read at | 2026-09-08 |
| Source of truth | [`bstBizEra/biztrust_guide`](https://github.com/bstBizEra/biztrust_guide) |
| Recorded by | agent, from the guide records; no status here is an agent decision |

## The single constraint

`BT-G0`, the architecture contract freeze, is **unrecorded**. Everything below
follows from that.

`BIZTRUST-ARCH-001` is `0.1-draft`, status `DRAFT FOR CONTRACT FREEZE`, and
states in its own header that implementation authority is **not granted by that
document**. The P0 design pack states that P0 implementation waits for `BT-G0`
and a Work Package with explicit, expiring authority in a platform repository.

This is the platform repository. It has no such Work Package.

## The foundation sequence

`FOUNDATION_SEQUENCE.md` orders eleven decision slices, `S01` to `S11`, and
`BT-G0` comes only after all eleven are accepted in order. Slice `S01` is the
tenant authority, jurisdiction and money-regime input contract. It needs five
human review seats — business authority, insurance domain, legal and
compliance, finance and accounting, and architecture — and it stops outright
when an agent is asked to infer contract authority from a product name or a
workflow.

None of those seats is filled. `S01` is not complete. No later slice may be
activated early.

## The ADRs this repository depends on

Every one is `DRAFT_REQUIRED`. None is accepted.

| ADR | Decides | Status | What depends on it here |
|---|---|---|---|
| ADR-001 | Modular monolith, the boundary rule, extraction criteria | `DRAFT_REQUIRED` | The seven dependency rules and one schema per module |
| ADR-004 | Shared PostgreSQL with row-level security | `DRAFT_REQUIRED` | The migration lint and the schema-per-module rule |
| ADR-005 | Contract-first HTTP APIs | `DRAFT_REQUIRED` | `openapi/` and `events/` being reserved and empty |
| ADR-010 | Durable workflow architecture | `DRAFT_REQUIRED` | Where a workflow lives; assumed to be a module calling contracts |
| ADR-011 | Tenant packs instead of tenant forks | `DRAFT_REQUIRED` | The rule that nothing is named for a tenant |

The rules in this repository are therefore the **proposal** of a design that is
itself `IN_REVIEW`. If ADR-001 narrows or widens them, `modules/modules.yaml`
and `scripts/boundary-rules.mjs` change in the same pull request and the
boundary suite is re-run.

## What that means for a reader

- **No capability is implemented.** Every module contract throws.
- **No capability is secure, compliant or production-ready**, and no evidence
  here supports such a claim.
- **The passing checks prove the boundaries, not the platform.** They prove
  that a rule fires on a violation and that the records conform to their
  schemas. They prove nothing about insurance, money or tenancy behaviour,
  because none exists.
- **The four module packages are boundaries, not features.** `tenancy`,
  `identity-access`, `audit` and `platform-configuration` exist so their
  boundaries can be tested first. Their contents are epics P0.6, P0.3, P0.10
  and P0.12 respectively, and none is authorised.

## The invariants this repository is shaped to make provable

From `BIZTRUST-ARCH-001` section 5. All are `INVARIANT_CANDIDATE` until the
architecture authority accepts them. Listed because the boundaries built here
exist to make them mechanically provable later, not because any is proven now.

| ID | Candidate invariant | What the skeleton contributes |
|---|---|---|
| INV-001 | Every tenant-owned record has exactly one tenant owner | The migration lint requires `tenant_id` on every created table |
| INV-002 | Tenant authority comes from validated identity context, never an untrusted client identifier | The identity-access contract shape; the resolver is epic P0.4 |
| INV-003 | Tenant A cannot read or mutate Tenant B data | Nothing yet. Epic P0.7. |
| INV-004 | Application authorization and PostgreSQL RLS enforce isolation independently | Nothing yet. Epic P0.7. |
| INV-010 | Provider-specific behavior stays behind an adapter boundary | Dependency rules 2, 4 and 5 |
| INV-012 | Public and inter-module interfaces are contract-first and versioned | Dependency rules 1, 2 and 5, enforced on every pull request |
| INV-015 | No implementation or compliance claim is accepted without revision-bound evidence | The evidence contract in `AGENTS.md` section 9, and this page |

## How to change this page

Do not update a status sentence here to a fresher one. A status sentence that
cannot expire is a defect class the guide repository records against itself: a
line true when written, merged after it had already become false, standing for
a day. Read the live state from its source instead:

- authority: [`badf/authority.yaml`](../../badf/authority.yaml)
- gates: [`badf/gates.yaml`](../../badf/gates.yaml)
- the contract and its ADR register: the guide repository

This page changes when one of those changes, in the same Work Package as the
change, and it names what moved.
