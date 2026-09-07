# BizTrust Platform — Repository Agent Operating Charter

This charter is the charter of `bstBizEra/biztrust_guide` with its work
constraints rewritten for a repository that ships software. The sections and
their order are kept, so that a reader of one charter can read the other.

## 1. Mission

Build and operate the BizTrust platform: a multi-tenant insurance brokerage,
distribution and insurance API platform. It is **not** an insurer
policy-administration or underwriting core.

**This repository currently contains no implementation.** It is the place every
later Work Package lands, shaped so that the modular monolith boundaries are
tested rather than intended. Every module contract throws. Read
[`docs/architecture/STATUS.md`](docs/architecture/STATUS.md) before assuming
otherwise.

## 2. Precedence

When instructions conflict, apply this order:

1. Human authority recorded for the active Work Package
2. Repository protection and security policy
3. This `AGENTS.md`
4. Active Work Package contract
5. Architecture decisions and normative documentation
6. Templates and examples

Unknown or conflicting authority is not permission. Set the state to
`WAIT_FOR_AUTHORITY`, record the blocker and stop the affected action.

## 3. Mandatory resume protocol

At the beginning of every session, agent handoff or recovery:

1. Read this file completely.
2. Read `badf/authority.yaml`. **It records that BT-G0 is unpassed and no P0
   epic is authorised.** Nothing below widens that.
3. Read `badf/current-state.json`.
4. Read `badf/next-actions.json`.
5. Locate the active Work Package, its scope and acceptance criteria.
6. Read the latest checkpoint and handoff referenced by current state.
7. Inspect the current Git branch, `HEAD`, worktree and remote divergence.
8. Run the validation commands of section 10 and reconcile observed with
   recorded state.
9. Output one resume decision: `CONTINUE`, `BLOCKED`, `WAIT_FOR_AUTHORITY`,
   `RECOVERY_REQUIRED` or `COMPLETE`.

An agent must not continue from chat recollection alone.

## 4. Sources of truth

| Concern | Source of truth |
|---|---|
| Repository policy | `AGENTS.md` |
| What is and is not authorised | `badf/authority.yaml` |
| Current operational state | `badf/current-state.json` |
| Ordered pending work | `badf/next-actions.json` |
| Allowed state transitions | `badf/lifecycle.yaml` |
| Gate results | `badf/gates.yaml` — every gate is recorded by a human |
| Roles and routing | `badf/agents.yaml` |
| Available capabilities | `badf/skills.yaml` |
| **The module list** | `modules/modules.yaml` — the one list; the boundary rules, the path map and the migration lint are generated from it |
| Human coordination | GitHub Issue / Project item |
| Delivery scope | Active Work Package |
| Architecture contract | `BIZTRUST-ARCH-001` in the guide repository — a **draft** |
| Architecture decision | An **accepted** ADR. None is accepted. |
| Code | Git commit on `main` — **not branch-protected**; the gate is convention, not mechanism, until the repository administrator records protection |
| Test result | CI run bound to a commit SHA |
| Session recovery | Latest valid checkpoint plus handoff |
| Approval | An explicit authority record; never inferred |

If sources disagree, record the conflict and stop the affected transition.

## 5. Work constraints

- **No ticket, no work.** Every material change references one Work Package ID.
- One Work Package has one objective, bounded scope and explicit acceptance
  criteria.
- **No implementation without an expiring grant.** A P0 epic may be implemented
  only when `badf/gates.yaml` records `BT-G0` and `badf/authority.yaml` records
  an implementation grant, with an expiry, from the business authority seat.
- **A module that is not in `modules/modules.yaml` does not exist.** It cannot
  import, be imported, or own a table. Adding a row is an architecture
  decision, not an engineering convenience.
- **A generated file is never hand-edited.** `.dependency-cruiser.cjs` and
  `tsconfig.paths.json` are generated from the registry; a hand edit fails
  `pnpm boundaries:check`.
- **The seven dependency rules are not negotiable inside a package.** A rule
  that must change is changed in the registry or the generator, by a pull
  request that says why. There is no override label.
- **A module owns one PostgreSQL schema and touches no other.** No foreign key
  crosses a schema boundary; another module's aggregate is referenced by its
  stable identifier.
- **The audit schema is append-only.** The migration lint refuses `UPDATE`,
  `DELETE`, `TRUNCATE`, `DROP`, a column drop and a type change against it.
- **P0 creates no domain table.** A table named for `policy`, `client`, `claim`
  or `premium` means the phase has been left, and the lint says so.
- Do not broaden scope because an adjacent improvement is convenient.
- Do not modify `main` directly when branch protection and pull requests are
  available.
- Do not overwrite unrelated human or agent changes.
- **Do not mark work accepted on the implementing agent's assertion.** The
  verifier is a different role with fresh context.
- Do not place secrets, tokens, private client information or regulated data in
  this repository. The validator scans for credential shapes on every run.
- **Synthetic data only.** No client, policy, claim or premium record, real or
  plausible, enters this repository.
- **No module, package, path or table is named for a tenant.** Tenant variation
  is configuration under ADR-011; a tenant name is a review finding.

## 6. Required session checkpoint

Create or update a checkpoint at every one of these boundaries:

- before a risky or long-running action;
- after a coherent implementation slice;
- before requesting authority;
- before switching agents;
- when blocked;
- before ending a session;
- after verification or release.

Every checkpoint conforms to `schemas/session-checkpoint.schema.json`,
mechanically checked by `scripts/validate_continuity.py`, and records: work
package and state; objective and completed scope; current branch and baseline
commit; files changed; validation commands **and their exit statuses**;
decisions and assumptions; blockers and authority status; exactly one
recommended next action; recovery instructions; and declared non-coverage.

## 7. Handoff contract

A handoff is required when responsibility changes. It identifies sender and
receiver roles; the stable Work Package ID; observed facts **versus** decisions;
completed, remaining and excluded work; the exact source revision; evidence
references; unresolved risks; the first safe command for the receiver; and stop
conditions.

Silence is never evidence of completion.

## 8. State transitions

`DRAFT → READY → AUTHORIZED → IN_PROGRESS → VALIDATING → ENGINEERING_READY → ACCEPTED → CLOSED`

Exceptional states: `BLOCKED`, `WAIT_FOR_AUTHORITY`, `RECOVERY_REQUIRED`,
`REJECTED`, `CANCELLED`.

`badf/lifecycle.yaml` names the role for each transition and which need a
human. Only an authorized transition may advance delivery. **Validation success
does not grant deployment authority, and a green build is not a gate result.**

## 9. Evidence requirements

Evidence is attributable, reproducible and bound to the relevant source
revision. At minimum record:

- repository and commit SHA;
- command or workflow identity;
- execution time and environment, including runtime, database and tool
  versions;
- exit status;
- material output or artifact reference;
- **verifier role, who is not the implementer** for any control on the `BT-G1`
  matrix;
- declared coverage **and declared non-coverage**.

A proof missing any field is not evidence. A negative control is a test
**observed failing before the protection exists and passing after**; a control
that has only ever been observed passing is not a control.

## 10. Change completion protocol

Before handoff or pull request, run all of these and record each exit status:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm boundaries:check
pnpm lint:migrations
node --test "tests/boundaries/*.test.mjs"
python3 scripts/validate_continuity.py     # py on Windows
python3 -m unittest discover -s tests/unit
```

Then:

1. Confirm no generated file was hand-edited.
2. Update `badf/current-state.json` and `badf/next-actions.json`.
3. Append any decision to `badf/decision-log.jsonl`.
4. Create a checkpoint under `sessions/checkpoints/`.
5. Summarize risks, non-coverage and the one next action.
6. Link the Work Package issue in the pull request.

## 11. Stop conditions

Stop immediately when:

- required authority is absent, ambiguous or expired;
- the repository state conflicts with the checkpoint;
- the active Work Package cannot be identified;
- validation fails on a protected invariant;
- sensitive data is detected;
- a destructive or irreversible action is outside explicit scope;
- evidence cannot be bound to the source revision;
- another agent has overlapping ownership without an explicit coordination
  record;
- **you are being asked to infer contract authority, legal authority or money
  ownership from a product name, a workflow or an application permission.**

That last one is the load-bearing stop. A BizTrust permission such as
`binding:confirm` only allows an actor to invoke a command. Whether the command
may represent cover as effective is a question about an accepted authority
agreement, and ADR-013 owns it. Application configuration cannot create legal
authority.

## 12. Current scope boundary

This repository may **describe** future BizTrust architecture. It must not
claim that a capability is implemented, secure, compliant or production-ready
unless linked, revision-bound evidence proves that claim.

Today no such claim can be made about anything here. `BIZTRUST-ARCH-001` is a
draft, `BT-G0` is unrecorded, every ADR is `DRAFT_REQUIRED`, and every module
contract throws.
