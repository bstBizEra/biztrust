# sessions

Checkpoints and handoffs: the primary input to recovery.

- `checkpoints/` — a checkpoint at every boundary `AGENTS.md` section 6 lists.
  Every file is validated against `schemas/session-checkpoint.schema.json` on
  every CI run.
- `handoffs/` — a handoff whenever responsibility changes, validated against
  `schemas/handoff.schema.json`.

An agent resuming work reads the checkpoint named by `latest_checkpoint` in
`badf/current-state.json`. The validator fails if that file does not exist.

Silence is never evidence of completion.
