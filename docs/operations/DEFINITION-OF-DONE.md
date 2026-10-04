# Definition of done

A Work Package is done when its stated scope is delivered and checked. Done at
the package level says nothing about a gate, an epic or the platform.

This page does not weaken `AGENTS.md`. Section 9 sets the evidence contract and
section 10 sets the completion protocol. This page says what to check before
claiming either is satisfied.

## The completion record

A package is complete when every line below is true or is explicitly recorded
as not applicable.

- The objective is met and no scope was added without authority.
- Each requirement traces to the code or document that satisfies it, and to the
  check that proves it.
- Success, invalid input, permission denial, failure and retry paths were
  checked. A test observes behavior. A test that restates the implementation
  proves nothing.
- Every claim is bound to a revision. An unbound claim is not evidence.
- Failed and unrun checks stay visible. Removing a failing check is not a fix.
- A finding closes only on evidence taken from the final candidate.
- The reviewer is a different role from the implementer, with fresh context.
- Affected documents, contracts and operational instructions are current in the
  same package.
- Secrets, credentials and client records are absent. The validator scans for
  credential shapes on every run.
- Unrelated work in the tree is untouched.

## What done does not mean

A complete package does not mean any of the following:

- A gate is recorded. Each gate is recorded by a named human role in
  `badf/gates.yaml`. A green build records nothing, and an instrument that
  passes is evidence for a gate decision, not the decision.
- An epic is finished.
- A capability is implemented, secure, compliant or ready for production.
- An ADR is accepted.

Do not write "production ready" or "enterprise grade" from this checklist. The
checklist cannot support either claim.

## Reporting outcomes separately

Report these as separate statements. Merging them hides which one failed.

| Outcome | The statement it needs |
|---|---|
| Implementation | What was delivered, and the exact candidate revision |
| Executed checks | Which passed, which failed, and the actual output |
| Unrun checks | Why unrun, what it blocks, and the prerequisite |
| Review | Independent findings, and which remain open |
| Owner decisions | What still waits on a human seat, and which seat |
| Next action | One authorized step, or a stop with its blocker and owner |

## Documentation-only work

A documentation package is checked by formatting, link resolution, diff review
and the continuity checks. It does not need a database, a deployment or an
invented application test. Adding one to look thorough is waste.
