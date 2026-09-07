# BizTrust

Multi-tenant insurance brokerage, distribution and insurance API platform.

> ## Nothing here is implemented
>
> This repository is the **platform skeleton**: the place every later Work
> Package lands, shaped so that the modular monolith boundaries are tested
> before there is anything behind them. Every module contract throws. There is
> no server, no database, no configuration and no deployment.
>
> That is not a gap to be quietly filled. `BIZTRUST-ARCH-001` is a draft, the
> `BT-G0` contract freeze is unrecorded, and every ADR this repository depends
> on is `DRAFT_REQUIRED`. Until an architecture authority records `BT-G0` and a
> business authority records an expiring implementation grant, no P0 epic may
> be implemented. See [`badf/authority.yaml`](badf/authority.yaml) and
> [`docs/architecture/STATUS.md`](docs/architecture/STATUS.md).

## What is built

The P0.2 design — *repository and modular boundaries* — from the engineering
guide, as far as it can be built without implementation authority.

| Built | Where |
|---|---|
| One pnpm workspace and the layout every later package lands in | `pnpm-workspace.yaml`, the top-level tree |
| The module registry: 30 modules, the one list everything is generated from | [`modules/modules.yaml`](modules/modules.yaml) |
| Seven dependency rules, generated from the registry | [`scripts/boundary-rules.mjs`](scripts/boundary-rules.mjs) → `.dependency-cruiser.cjs` |
| The migration lint: one schema per module, audit append-only, no P0 domain table | [`scripts/migration-lint.mjs`](scripts/migration-lint.mjs) |
| A fail-closed record validator | [`scripts/validate_continuity.py`](scripts/validate_continuity.py) |
| Fixtures proving every rule fires | [`tests/boundaries/`](tests/boundaries/) |
| The charter, the registries and the continuity records | [`AGENTS.md`](AGENTS.md), [`badf/`](badf/) |
| The CI job skeleton | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |

Four module packages exist because the P0.2 design names them as the modules P0
builds: `tenancy`, `identity-access`, `audit` and `platform-configuration`.
Each has a public contract and a private internal half. Every exported function
throws with a message naming the epic that would fill it. The other 26 modules
are registry rows with no directory, and the rules still cover them, because
the rules are generated from the rows.

## The seven dependency rules

Generated from the registry, enforced on every pull request, and each observed
firing on a deliberate violation under `tests/boundaries/`.

1. **A module's internals are private.** Only that module imports its
   `src/internal/`.
2. **Modules depend on contracts.** A cross-module import lands on
   `src/public/index.ts` and nothing else. Never a repository, a table or a
   connection.
3. **No cycles.** A pair of modules that need each other is one module or a
   missing contract.
4. **Shared code is not domain code.** `packages/*` may be imported by any
   module and may import none.
5. **Entry points see contracts only.** `services/*` and `apps/*` import
   contracts and packages; nothing imports them.
6. **Test packages stay in tests.** Nothing outside `tests/` imports anything
   inside it.
7. **The control plane sees packages only.** `apps/control-plane` reaches the
   platform through the admin API, never through an in-process contract call
   that would pass the token chain, the tenant resolver and the audit by.

## Getting started

```bash
pnpm install
pnpm typecheck
pnpm boundaries:check
pnpm lint:migrations
node --test "tests/boundaries/*.test.mjs"
python3 scripts/validate_continuity.py       # py on Windows
python3 -m unittest discover -s tests/unit   # py on Windows
```

All seven pass on `main`. There is nothing to run, because nothing is
implemented.

To add or change a module, edit [`modules/modules.yaml`](modules/modules.yaml)
and regenerate:

```bash
node scripts/generate-boundary-rules.mjs
```

Never hand-edit `.dependency-cruiser.cjs` or `tsconfig.paths.json`.
`pnpm boundaries:check` fails if you do.

## What the checks actually enforce

| Check | What a failure means |
|---|---|
| `boundaries:check` | Either a generated file drifted from the registry, or one named rule was broken by one named file. There is no override label; a rule that must be relaxed is changed in the registry by a pull request that says why. |
| `lint:migrations` | A migration touched a schema it does not own, crossed a schema with a foreign key, mutated the audit schema, created a P0 domain table, omitted `tenant_id`, or sat in a directory naming no registered module. |
| `validate_continuity.py` | A record under `badf/` or `sessions/` drifted from its schema, or broke a rule the schema cannot express: exactly one primary action named by the state file, priorities 1 to n, one Work Package id across both records, decision ids unique and ascending. |
| `tests/unit` | The validator itself. 23 tests break one thing at a time and require each to be reported, because an instrument never observed failing is indistinguishable from one that passed. |
| `tests/boundaries` | The rules and the lint. 25 tests: 8 boundary controls and 7 migration controls each observed firing on its fixture, and 5 conforming imports reported by nothing. A fixture that passes is itself a failure. |

The validator's exit codes carry meaning: **0** pass · **1** a data defect, the
records are wrong · **2** a validator defect, the script is broken · **130**
interrupted. Treating any non-zero as failure is correct; 1 and 2 differ so a
reader knows which artifact to debug.

## What is not covered

Recorded because a gap that reads as an omission is worse than one that reads
as a decision.

- **Negative control 6 of the P0.2 design** — a push straight to `main`, and a
  merge with a failing check — cannot be observed. `main` is unprotected, and
  protecting it is a human record no agent can write. This is the primary next
  action.
- **Every runtime control.** Nothing runs.
- **The contract lint** over `openapi/` and `events/`. Both are reserved and
  empty; the rules are epics P0.8 and P0.9.
- **The observability tests.** The baseline is epic P0.11.
- **The security proof suite.** The `BT-G1` matrix needs `BT-G0` first.
- No fixture proves the typecheck fails, so the compiler is an unwitnessed
  instrument.

## Governance

Read [`AGENTS.md`](AGENTS.md) before changing anything, and
[`badf/authority.yaml`](badf/authority.yaml) before assuming you may. The short
version: no ticket, no work; a module outside the registry does not exist;
generated files are never hand-edited; work is never accepted on the
implementing agent's own assertion; and application permission never
substitutes for legal, insurer-delegated or scheme authority.

The engineering guide this repository is built from is
[`bstBizEra/biztrust_guide`](https://github.com/bstBizEra/biztrust_guide).
