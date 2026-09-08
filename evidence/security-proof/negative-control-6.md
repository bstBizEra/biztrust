# Negative control 6, observed

**Control (P0.2 design):** a push straight to `main` is refused, and a pull
request with a failing check cannot merge.

**Status:** OBSERVED. This control was recorded as declared non-coverage in
every prior checkpoint, because the protection that produces the refusal is a
repository-administrator act and an agent claiming it would be claiming a human
decision.

| Field | Value |
|---|---|
| Repository | `bstBizEra/biztrust` |
| Branch under test | `main`, at `062a0f7c1b350e4af695978b238b28e323b7d0e0` |
| Work package | `BIZTRUST-WP-001`, action `NS-001` |
| Observed at | 2026-09-08T04:30Z to 2026-09-08T04:50Z |
| Environment | GitHub-hosted, `gh` CLI as `bstBizEra`; CI on `ubuntu-latest` |
| Applied by | agent, on a direct operator instruction given in session |
| Recorded by | NOT YET RECORDED — see "What is still missing" |

## Protection applied

```
enforce_admins                  true
required_status_checks          Verify, Scope boundary   (strict)
required_approving_reviews      1
dismiss_stale_reviews           true
required_conversation_resolution true
allow_force_pushes              false
allow_deletions                 false
```

`enforce_admins: true` matters here more than the rest. Without it the refusals
below would demonstrate only that the rule applies to people who are not the
repository owner, which is not the control.

## First half: a direct push is refused

An empty commit whose tree is byte-identical to `main`'s was built with
`git commit-tree` and pushed directly. An empty commit was used deliberately:
if the protection had failed, `main` would have gained a commit that changed no
file, rather than an unreviewed branch head.

```
remote: error: GH006: Protected branch update failed for refs/heads/main.
remote:
remote: - Changes must be made through a pull request.
remote:
remote: - 2 of 2 required status checks are expected.
 ! [remote rejected] c6cef33c912e80d90e780960523c795db6d9f69b -> main (protected branch hook declined)
error: failed to push some refs to 'https://github.com/bstBizEra/biztrust.git'
```

Exit status 1. `main` remained at `062a0f7c1b350e4af695978b238b28e323b7d0e0`.

## Second half: a pull request with a failing check cannot merge

Pull request #2 was opened from `test/negative-control-6` carrying one
deliberately violating migration, `0002_negative_control_6_probe.sql`, creating
a P0 domain table. CI failed on the rule that should catch it:

```
MIGRATION_LINT db/migrations/tenancy/0002_negative_control_6_probe.sql: M4:
  table "policies" is named for the domain word "policy"; P0 builds no domain
  table, and a table by this name means the phase has been left
MIGRATION_LINT FAIL 1 violation(s) in 3 file(s)
```

The merge was then attempted **with `--admin`**, which is the strong form of the
test:

```
GraphQL: At least 1 approving review is required by reviewers with write access.
Required status check "Verify" is failing. (mergePullRequest)
```

Exit status 1.

Pull request #2 was closed without merging and its branch deleted. `main` is
unchanged.

## Third observation: the effect on an honest pull request

Pull request #1, with both required checks green, moved from freely mergeable to
`mergeStateStatus: BLOCKED`, `reviewDecision: REVIEW_REQUIRED`. Before this
protection existed, every green CI run on that pull request proved nothing about
whether a red one could be merged past. That is the difference between a gate
that is convention and a gate that is mechanism.

## What is still missing

`NS-001` is **not complete**. Its acceptance has two halves and only one is
done:

1. The protection exists and the control is observed. Done, above.
2. *"A named human holds the seat in `badf/agents.yaml`."* Not done. The
   `repository-administrator` role is recorded `may_be_an_agent: false` and the
   registry has no field capable of holding an occupant's name — occupancy lives
   in a free-text `note: "Unfilled."`, which peer review round three noted means
   the primary action cannot be recorded in the record it names.

So `badf/authority.yaml` still reads `main_branch_protection: NOT_RECORDED`, and
`badf/current-state.json` still reads
`NOT_RECORDED_REQUIRES_REPOSITORY_ADMIN`. That combination — the mechanism in
place, the record absent — is unusual and is stated rather than smoothed over.
An agent applied a setting on an operator's instruction; that is not the same as
a named human recording that they decided it, and only the second is what the
P0.2 design asks for.
