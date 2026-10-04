# How a review is conducted here

`AGENTS.md` requires a **verifier who is not the implementer** with fresh
context. It does not say how that verifier should work. This file does, and
every rule below was learned by watching it fail first.

When `AGENTS.md` gains a section on review, this file is what it should point
at. Until then, `docs/**` routes to `peer-reviewer`, which is who this is for.

---

## 1. Build the environment. Do not reason from the diff.

**The rule:** if a claim is about what happens in some environment — a shallow
clone, a grafted history, a signed commit, a dirty tree, a concurrent run —
construct that environment and run it. A review that reads code and reasons
about it will miss the class of defect this repository keeps producing.

**Why, with the evidence.** Three times a reviewer built something an
implementer had not, and three times the built thing contradicted what was
written:

- A reviewer generated an SSH signing key in a throwaway clone and drove the
  signing check's `PASS`, `FAIL`, wrong-identity, unresolvable-anchor and
  ambiguous-anchor paths end to end. The implementer had recorded that path as
  impractical to test. It took under a minute.
- A reviewer ran `git clone --depth 1` and found that a shallow clone resolved
  the enforcement point to `HEAD` and printed `PASS` having verified nothing.
  **A docstring, a report and a CI comment all stated that this case exits 2.**
  All three were false, and no amount of reading would have shown it.
- A reviewer wrote `HEAD`'s sha into `.git/info/grafts` and reproduced the same
  false `PASS` in a repository git reports as *not* shallow — disproving the
  stated justification for the fix that had just shipped, and correcting a
  `DEC-` record in the process.

**The corollary:** a claim in a docstring, a report, or a CI comment is not
evidence. It is a hypothesis with good grammar. Three of them agreeing is not
three pieces of evidence; it is usually one person's belief, copied.

---

## 2. "Impractical to test" is itself a finding.

**The rule:** when an implementer says a path cannot be witnessed, treat that
sentence as the thing under review. Ask which specific case needs the expensive
setup, and check whether the claim was generalised from it to cases that do
not.

**Why, with the evidence.** An implementer wrote that testing the signing
check's enforced paths required key material or fabricated `git` output. That
was true of exactly one path — a verified `PASS` — and false of five others:
the ambiguous anchor, the missing anchor, the unresolvable sha, the malformed
log record and the failed git command all need no key at all. Six refusals had
shipped unwitnessed behind one true sentence about one of them.

The honest form of the claim is narrow: *"this specific case needs key
material."* The unreviewable form is broad: *"this area is impractical to
test."* The second is where unwitnessed code hides.

---

## 3. Read the whole, not only the change.

**The rule:** at least once per body of work, review the changes **together**.
Some defects exist only in the interaction and are structurally invisible to a
per-change review, however good.

**Why, with the evidence.** One task inverted a default so that an unmodelled
statement is refused. A later task added scans that push a target from anywhere
in a statement. Because "was this statement understood?" was satisfied by *any*
target, an unmodelled statement carrying an incidental own-schema reference
stopped being refused — `COMMENT ON FUNCTION`, `GRANT EXECUTE ON FUNCTION` and
`SECURITY LABEL` were refused, then silently passed again. Each task's own
review was correct. Only reading the six changes as one body found it.

---

## 4. Ask the instrument the question it asks of everything else.

**The rule:** whatever a check exists to detect, check the check for it. This
repository has put its own defect class *inside* the instrument built to detect
that class four separate times.

- The coverage gate — built to find protections witnessed by nothing — was
  itself witnessed by nothing, and one environment variable neutered it *and*
  all four of its witnesses at once.
- The attribution gate's verdict wiring could have one term deleted and would
  still print its refusal and exit 0.
- The guard that refuses a truncated history was bypassed by a truncated
  history it did not recognise.
- Four coherence rules in the record validator shared one control between them,
  so three were deletable in silence.

**The test to apply:** delete the guard. If the suite stays green, the guard is
decoration. This is cheap, and it is the single highest-yield thing a reviewer
can do here.

---

## 5. Verdict discipline

- **Two verdicts, always.** Spec compliance *and* quality. A report missing
  either is not a review.
- **Reproduce before reporting.** A finding carries the command and its output,
  not a description of what would happen.
- **Say when a category is empty.** "No Critical findings" is information;
  padding a section to look thorough is not.
- **Name what you could not verify.** An unverifiable claim recorded as
  unverified is worth more than one quietly assumed.
- **Leave the tree exactly as found.** `git status --porcelain` empty, no stray
  worktrees, no `refs/replace`, no `.git/info/grafts`. A reviewer who dirties
  the repository has damaged the evidence.

---

## 6. What a reviewer may not do

A reviewer reports; it does not fix. It does not approve a lifecycle gate, does
not record a gate result, and does not accept a Work Package — `AGENTS.md` §5
and `badf/lifecycle.yaml` reserve acceptance for a human verifier who is not
the implementer, and `scripts/validate_continuity.py` refuses a state that runs
ahead of its acceptance record.

An agent review is evidence for that human's decision. It is not the decision.
Five rounds of agent review have been conducted on this branch and the Work
Package is still `ENGINEERING_READY`, which is the correct outcome and not a
failure of the reviews.
