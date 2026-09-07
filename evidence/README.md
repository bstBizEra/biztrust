# evidence

Evidence manifests bound to a source revision.

**Empty.** Evidence is produced by CI runs, and CI has never run: this
repository has no commit on `main` beyond its initial one and no protected
branch.

Every manifest records what `AGENTS.md` section 9 requires: repository and
commit SHA; command or workflow identity; execution time and environment with
runtime, database and tool versions; exit status; the artifact or output
reference; the verifier role, who is not the implementer for any control on the
`BT-G1` matrix; declared coverage; and declared non-coverage.

A manifest missing any field is not evidence. `evidence/security-proof/` is
reserved for the `BT-G1` matrix, which needs `BT-G0` first.
