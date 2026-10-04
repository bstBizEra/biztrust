# PROPOSAL — how the first occupant of a human-only seat is seated

**Status: NOT ADOPTED. This is a draft awaiting the very seat it describes.**

No agent may adopt this. It is written down so the problem is visible and the
options are costed, not so that it can be applied.

## The problem: a seat that is its own verifier

`badf/agents.yaml` routes changes to itself:

```yaml
  - path: "badf/agents.yaml"
    owner: architecture-authority
    verifier: repository-administrator
    note: >-
      This file decides which seats exist, which may be held by an agent, and
      who reviews what. An agent may never be the verifier of a change to it.
```

Filling the `repository-administrator` seat **is** a change to
`badf/agents.yaml`. So seating the first repository administrator requires a
repository administrator to verify it. Nothing in this repository records how
that loop is broken.

The same shape blocks two other things, both currently recorded as next
actions:

- `badf/signing-policy.yaml` is `owner: repository-administrator`. Enrolling
  the first signing key therefore needs the seat that is not filled.
- `AGENTS.md` is `owner: repository-administrator`. Amending the charter needs
  it too.

And `held_by` is pinned to the literal `null` by
`scripts/validate_continuity.py`, so seating anyone is also a change to the
validator in the same pull request — which is deliberate (`DEC-007`'s cost
applied to seats), and is a *separate* routing path (`scripts/**` →
`platform-engineer` / `peer-reviewer`) from the record it accompanies.

## Why an agent must not resolve this

`badf/authority.yaml` `tool_authority.may_not` forbids an agent to *"Grant,
extend or infer authority, including its own."* A rule that decides who may
seat an authority is a rule about authority. An agent writing it would be
choosing the mechanism by which every later authority in this repository comes
into being — which is a larger act than any single grant it is forbidden to
make.

That is why this file stops at four options and a recommendation.

## The options

### (a) A bootstrap rule, written into `badf/agents.yaml` as a rule

The **first** fill of a seat whose `may_be_an_agent` is `false` is verified by
a different `may_be_an_agent: false` seat; every subsequent change to that
seat's occupancy is verified normally.

- **For:** survives the next vacancy. Preserves the property the file's own
  note protects — no agent is ever the verifier. Makes the loop-breaking
  mechanism a readable rule rather than an undocumented event.
- **Against:** it is still a change to `badf/agents.yaml`, so adopting it faces
  the same circularity it solves. It has to be adopted by option (c) or (d)
  once, and then it holds forever after.

### (b) `architecture-authority` verifies the first fill

It is already the *owner* of `badf/agents.yaml`.

- **For:** no new rule; uses a seat the file already names for this path.
- **Against:** `architecture-authority` is also unfilled, so it moves the loop
  by one step rather than breaking it. It answers "who verifies?" and not "who
  is seated first?"

### (c) An out-of-band operator instruction

The way `granted.repository_scaffold` was created: an operator asserts it, an
agent records it, and the record says plainly that it is an operator
instruction and not a seated decision.

- **For:** it is the only option with precedent in this repository, and it
  demonstrably works — the whole skeleton was built under it.
- **Against:** it leaves the loop open for the next seat, and the existing
  precedent is explicit that such a record is *not* the thing the design asks
  for. `granted.repository_scaffold` carries its own `honest_status` saying so.

### (d) One human takes both seats at once

`architecture-authority` and `repository-administrator` filled in a single act
by one person, who then verifies subsequent changes.

- **For:** breaks the loop immediately with no new rule.
- **Against:** it collapses a separation of duties the routing table exists to
  create — the two seats verify each other across four different paths. It may
  be unavoidable in a small organisation, but it should be a recorded choice
  with an expiry, not a silent convenience.

## Recommendation

**(a), adopted once by (c).** The operator instruction seats the first
administrator and records the bootstrap rule in the same act; from then on the
rule holds and no further out-of-band instruction is needed. That is the only
combination that both breaks the loop now and closes it for the next vacancy.

If (d) is what actually happens — one person holding both seats — record it as
(d) with an expiry rather than letting it read as (a).

## What must accompany whichever is chosen

1. The validator change that unpins `held_by` for the seat being filled, in the
   same pull request (`scripts/validate_continuity.py`, and its unit control).
2. A `DEC-` record naming the option chosen, the human seated, and the
   authority under which they were seated.
3. `badf/authority.yaml`'s `main_branch_protection` moved from
   `NOT_RECORDED_REQUIRES_REPOSITORY_ADMIN` to `RECORDED`, which is a
   schema-pinned enum change and therefore a reviewed edit.
4. Before any signing key is enrolled: nothing further. `DEC-030` closed the
   `.git/info/grafts` precondition that `DEC-029` had gated this on.

## Provenance

Drafted by an agent during round five of BIZTRUST-WP-001, after the routing
table was read closely enough to notice the loop. Recorded under
`badf/authority.yaml` `tool_authority.may` — *"Append to
badf/decision-log.jsonl"* and the general permission to read and describe — and
explicitly **not** under any authority to adopt it.
