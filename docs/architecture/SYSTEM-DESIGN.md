# BizTrust platform system design

BizTrust is a brokerage service platform. One deployment serves insurers,
brokers and the agents of those brokers. Each is a tenant of the same system.

This page is the platform view of that design. It is not the architecture
contract. The contract is `BIZTRUST-ARCH-001` in
[`bstBizEra/biztrust_guide`](https://github.com/bstBizEra/biztrust_guide), and
it is a draft. Where this page and the contract disagree, the contract wins and
the disagreement is a finding.

| Field | Value |
|---|---|
| Status | `PROPOSED`. No agent may accept it. |
| Read at | 2026-09-29 |
| Source of truth | The guide repository, for every decision named below |
| Decides | Nothing. It states what follows from decisions recorded elsewhere. |

Read [architecture status](STATUS.md) first. It records that `BT-G0` is
unrecorded, and everything here waits on that.

## 1. What the platform is

A broker places insurance for a client. The broker does not carry the risk. An
insurer carries it. The broker may hold client money on the way through.

BizTrust runs that work for many brokers at once. A single deployment holds
many tenants. A tenant is an insurer, a broker, or an agent network under a
broker.

Three properties follow, and they shape everything else:

1. **Tenants share infrastructure and must not share data.** Isolation is the
   first-order requirement, not a feature.
2. **Tenants differ in product, wording, jurisdiction and money regime.** The
   difference is configuration, never a fork.
3. **Some records are authoritative about cover or money.** Those records carry
   legal weight, and the rules that govern them are not this repository's to
   invent.

## 2. What is decided, and what is blocked

The design splits cleanly, and the split is the most useful thing on this page.

### Decided enough to build against

| Question | Where | Status |
|---|---|---|
| Modular monolith first, with a boundary rule | ADR-001 | `PROPOSED` |
| Shared PostgreSQL with row-level security as default isolation | ADR-004 | `PROPOSED` |
| Durable workflow architecture | ADR-010 | `PROPOSED` |

`PROPOSED` is not accepted. These may be built against only under an expiring
grant recorded in `badf/authority.yaml`, after `BT-G0`.

### Blocked, and blocked on the same thing

| Question | Where | Status |
|---|---|---|
| Who may create authoritative cover, under which delegated authority | ADR-013 | `BLOCKED_BY_S01` |
| Which client-money and risk-transfer regime governs premium and claims money | ADR-014 | `BLOCKED_BY_S01` |
| How co-insurance, layers, facilities, certificates and account-current work | ADR-016 | `BLOCKED_BY_S01` |
| Who owns product, wording, rating, indication and insurer quote | ADR-017 | `BLOCKED_BY_S01` |

All four wait on slice `S01`, the tenant authority and money-regime input
contract, which is guide issue #15 and is open.

**This is the finding.** The four questions a brokerage platform most needs
answered are the four that no one has answered. They are not blocked by
engineering. They are blocked on human review seats, three of which are
unfilled. Until they are answered, the platform can build its tenancy, identity
and audit foundation, and it cannot build cover or money.

### Drafted but not decided

ADR-005 (contract-first HTTP APIs) and ADR-011 (tenant packs) are
`DRAFT_REQUIRED`. ADR-008 (the immutable double-entry subledger) and ADR-015
(valid time, record time, correction and supersession) are `DRAFT_REQUIRED`,
and both are prerequisites for any money or cover-state work.

## 3. The tenancy model

ADR-004 proposes one PostgreSQL cluster, shared by all tenants, with row-level
security as the isolation mechanism. Four candidate invariants carry that
proposal, and none is proven today.

| ID | Candidate invariant | Where it is made provable |
|---|---|---|
| INV-001 | Every tenant-owned record has exactly one tenant owner | The migration lint requires `tenant_id` on every created table |
| INV-002 | Tenant authority comes from validated identity context, never a client-supplied identifier | The `identity-access` contract, epic P0.3. The resolver is epic P0.4. |
| INV-003 | Tenant A cannot read or mutate Tenant B data | Epic P0.7. Nothing yet. |
| INV-004 | Application authorization and database row-level security enforce isolation independently | Epic P0.7. Nothing yet. |

INV-004 is the one that matters most and costs most. It requires two
independent enforcement paths, so that a defect in application code does not
become a cross-tenant read. A single path is cheaper and is not the design.

**Nothing is named for a tenant.** No module, package, path, table or column
carries a tenant name. Tenant variation is configuration, under ADR-011. A
tenant name in the tree is a review finding, and `modules/modules.yaml` says so
in its own header.

## 4. The module map

`modules/modules.yaml` is the one list. This page does not repeat it, because a
second list becomes a second source of truth and then the two disagree.

Thirty modules are registered in four groups. Each module owns one PostgreSQL
schema and touches no other. No foreign key crosses a schema boundary. Another
module's aggregate is referenced by its stable identifier.

| Group | Count | What the group answers for |
|---|---|---|
| platform | 6 | Tenancy, identity, audit, configuration, distribution, compliance |
| brokerage | 12 | The path from a client need to a policy record, and claims and renewal |
| financial | 6 | Billing, payment, ledger, commission, settlement, reconciliation |
| integration | 6 | Insurers, payment providers, banks, partners, documents, notifications |

Four packages exist today: `tenancy`, `identity-access`, `audit` and
`platform-configuration`. They exist so their boundaries can be tested first.
Every contract throws. The other twenty-six rows are registry entries and
nothing else.

## 5. The four flows

The module groups exist to carry four flows. Each is named here so that a
design for one can be recognized as a design for one, and not widened by
accident.

1. **Placement.** A client need becomes a submission, a submission becomes a
   placement, a placement produces quotes and a recommendation, and a bind
   produces a policy record. Who may bind is ADR-013, and it is blocked.
2. **Money.** Premium is billed, paid, posted to a ledger, split into
   commission, settled with the insurer and reconciled. Which regime governs
   the money is ADR-014, and it is blocked. How the ledger is represented is
   ADR-008, and it needs a draft.
3. **Claims.** A claim is notified, assessed and settled. Claims money follows
   the same blocked regime question as premium.
4. **Renewal.** A policy record reaches term and re-enters placement. Renewal
   depends on cover state over time, which is ADR-015, and it needs a draft.

Flows 1 and 2 cross the brokerage and financial groups. That crossing is where
the boundary rule earns its cost, and where a cross-schema foreign key would be
easiest to reach for and is refused.

## 6. Cover state and money are the sharp edges

Two classes of record carry legal weight.

**Cover state** answers what was covered, for whom, when, and on whose
authority. It is not a current-value field. A correction made today about cover
that started last month must not erase what the record said yesterday. That
shape is bitemporal, and ADR-015 owns it.

**Money** held for a client is not the broker's money. Whether BizTrust holds
client money at all, and under which regime, is ADR-014. The answer changes the
ledger, the settlement path and the audit requirement, so no money module can
be designed before it.

The guide records a governance rule over both: the insurance practitioner
review seat is required for any change touching cover state or money. That seat
is unfilled. The rule therefore blocks acceptance, not drafting.

## 7. What P0 may and may not do

P0 builds the foundation and no domain.

- P0 creates no domain table. A table named for `policy`, `client`, `claim` or
  `premium` means the phase has been left, and the migration lint says so.
- The `audit` schema is append-only. The lint refuses `UPDATE`, `DELETE`,
  `TRUNCATE`, `DROP`, a column drop and a type change against it.
- No module may be added without a row in `modules/modules.yaml`, and adding a
  row is an architecture decision.

The four platform packages map to epics P0.6, P0.3, P0.10 and P0.12. None is
authorized. Authorization needs `BT-G0` recorded in `badf/gates.yaml` and an
expiring implementation grant in `badf/authority.yaml` from the business
authority seat.

### One gap found while writing this page

The guide defines eight delivery gates, `BT-G0` to `BT-G7`. This repository's
`badf/gates.yaml` registers five, `BT-G0` to `BT-G4`. The three missing gates
are not recorded as absent anywhere, so a reader of either file alone would not
see the difference.

This page does not resolve that. Reconciling the two registries is an
architecture decision, and it needs its own Work Package.

## 8. What this design does not decide

It does not decide any ADR. It does not fill a review seat. It does not record
a gate. It does not grant implementation authority. It does not choose a
jurisdiction, a money regime, a product model or a binding authority.

An agent produced it. An agent may not accept it.

## 9. How this page changes

Do not refresh a status sentence here to a fresher one. Read the live state
from its source:

- gates: [`badf/gates.yaml`](../../badf/gates.yaml)
- authority: [`badf/authority.yaml`](../../badf/authority.yaml)
- modules: [`modules/modules.yaml`](../../modules/modules.yaml)
- the contract and its ADR register: the guide repository

This page changes when one of those changes, in the same Work Package, and it
names what moved.
