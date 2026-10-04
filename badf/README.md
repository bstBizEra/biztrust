# BADF continuity surface

The machine-readable operational entry point for agents working in this
repository. Read these files before reading any code.

## The records

| File | What it is |
|---|---|
| `current-state.json` | Exactly one authoritative active state |
| `next-actions.json` | Ordered, owned and bounded actions; exactly one is primary |
| `decision-log.jsonl` | Append-only decision records, ids unique and ascending |

## The registries

| File | What it is |
|---|---|
| `lifecycle.yaml` | The allowed state transitions and which need a human |
| `authority.yaml` | What is granted, what is not, and who holds each decision |
| `gates.yaml` | Every delivery gate and the instrument whose output it reads |
| `agents.yaml` | Roles, which may be an agent, and how a path routes to one |
| `skills.yaml` | Capabilities, each with the authority its use would need |

`authority.yaml` is the one to read first. It records that **BT-G0 has not been
passed and no P0 epic is authorised**, which is why every module contract in
this repository throws.

## What the validator checks

`py scripts/validate_continuity.py` (`python3` on Linux) validates the three
records against `schemas/*.schema.json` and enforces the rules a schema cannot
express:

- exactly one primary action, and `current-state.json` names it;
- action priorities run 1 to n with no gap and no repeat;
- one Work Package id across the state file and the action file;
- the checkpoint named by `latest_checkpoint` exists and conforms;
- decision ids unique and ascending;
- every registry parses and declares a version.

The validator is fail-closed: a malformed record produces exactly one
`CONTINUITY_VALIDATION` line and a non-zero exit, never a traceback and
silence, which reads as success. `tests/unit/test_validator_fails_closed.py`
proves that on deliberately broken fixtures.

Exit codes: **0** pass; **1** a data defect, the records are wrong; **2** a
defect in the validator itself; **130** interrupted. A consumer treating any
non-zero as failure is correct; 1 and 2 differ so a reader knows which artifact
to debug.

## NS ids are point-in-time

`next-actions.json` allocates `NS-nnn` ids as a rolling counter and retires the
previous block rather than re-using it. An id is meaningful only against the
revision of `next-actions.json` that issued it. To resolve an id recorded in an
older checkpoint, read the revision current at that checkpoint's `created_at`:
`git log -p badf/next-actions.json`.

## The rule these files exist to enforce

Chat context may help interpretation. It cannot override repository state and
it cannot grant authority.
