#!/usr/bin/env node
/**
 * Is a change to a governance record bound to a HUMAN, or only to whoever was
 * holding the keyboard - which, in this repository, is an agent?
 *
 *   node scripts/check-signing.mjs
 *
 * WHAT THIS CLOSES, AND WHAT IT DOES NOT. Every other check here constrains
 * what a record may SAY. None of them constrains who WROTE it. A forgery that
 * edits badf/authority.yaml, badf/current-state.json and the checkpoint
 * CONSISTENTLY passes all of them - not a theory, it was tried - because every
 * validator reads the same files the forger writes. No reader can close that.
 * A signature the acting agent cannot produce can, and git commit signatures
 * are the primitive available here.
 *
 * THIS CHECK IS NOT YET ENFORCEMENT, AND IT SAYS SO IN CAPITALS. badf/
 * signing-policy.yaml enrols no key, because enrolling one is a human act and
 * no agent may do it. While it enrols none, this script prints
 *
 *   SIGNING_CHECK NOT_ENFORCED ...
 *
 * and exits 0. It never prints SIGNING_CHECK PASS in that state - the two
 * statuses are different words precisely so that `grep` can tell an unenforced
 * control from an enforced one, which is the defect class this whole branch
 * exists to close: an unenforced control that prints nothing is
 * indistinguishable from an enforced one.
 *
 * WHY EXIT 0 RATHER THAN FAILING. The repository has precedent both ways: the
 * coverage gate's declared non-coverage reports honestly without failing,
 * while the mutation check's dirty-tree guard fails outright. The line between
 * them is who can act on the failure. A dirty tree is remediable by the agent
 * reading the message; an unenrolled key is not remediable by ANY agent, by
 * construction. A gate that no legitimate action can make green is a gate the
 * next agent deletes, weakens or works around, and this branch already has one
 * finding per round of an instrument quietly neutered to keep a suite green.
 * So it nags, loudly, in a word no other status uses, and it becomes a gate
 * the moment a human enrols a key - with no code change, because the
 * enforcement is driven by the policy data and not by an edit here.
 *
 * WHAT MAKES IT BITE THE DAY A KEY IS ENROLLED. accepted_keys stops saying
 * NONE_ENROLLED, and every commit at or after the enforcement point that
 * touches a protected path must carry a good signature from an accepted
 * identity, or this exits 1 and `pnpm verify` is red.
 *
 * NO RETROACTIVE REQUIREMENT. The enforcement point is EXCLUSIVE and defaults
 * to the commit that added the policy. Nothing before the policy existed is
 * ever asked for a signature: no commit on this branch is signed, no signing
 * key is configured, and rewriting history is not a repair.
 *
 * A SHALLOW CLONE IS REFUSED OUTRIGHT, and that refusal is load-bearing
 * rather than defensive. In a shallow clone the grafted root commit has no
 * parent, so EVERY file reads as added there and
 * `git log --diff-filter=A -- badf/signing-policy.yaml` returns exactly one
 * sha: the root. Neither the no-adds nor the ambiguous-adds refusal below
 * fires, the enforcement point silently becomes HEAD, and the check reports
 * PASS having verified nothing at all. `--depth N` is worse than `--depth 1`,
 * because it narrows the governed range to the last N commits instead of
 * collapsing visibly to zero. Review of this task demonstrated the whole
 * bypass in a real `git clone --depth 1`, against a version of this file whose
 * comment claimed it could not happen - the claim rested on one line of CI
 * YAML (`fetch-depth: 0`) that nothing tested, so deleting that line made
 * nothing go red. `git rev-parse --is-shallow-repository` is asked before any
 * commit is resolved, and the answer `true` is exit 2. (It is asked after the
 * POLICY is read, deliberately: an unreadable policy is exit 1 wherever it is
 * read, because the file being wrong is a fact about the file and not about
 * this repository's history. An earlier version of this sentence said "asked
 * first", which was false in exactly that case, and a comment that is false
 * about the order it is describing is the same defect as a check that is
 * green about a rule it is not running.)
 *
 * A GRAFTED HISTORY IS THE SAME BYPASS WITHOUT THE SHALLOW FLAG, and it is
 * closed a level lower down, in `git()` below, by TWO independent settings -
 * because it turns out there are two independent ways to graft. Every git
 * call this file makes passes `--no-replace-objects`, so `refs/replace`
 * cannot rewrite the history the check reads. That flag does NOT touch
 * `.git/info/grafts`, git's older, deprecated graft mechanism: DEC-029
 * recorded that writing HEAD's own sha into that file reproduces the exact
 * same bypass - the enforcement point resolves to HEAD and the check reports
 * PASS having verified nothing - with `--no-replace-objects` present and
 * doing nothing about it, because grafts and replace refs are different
 * mechanisms that happen to produce the same symptom. `git()` also sets
 * `GIT_GRAFT_FILE` to the null device on every call, so `.git/info/grafts`
 * is never consulted regardless of what a write to it contains. See the
 * comment on that helper for why both are per-call settings rather than a
 * refusal added here.
 *
 * Exit codes: 0 every governed commit verified, or the policy enrols no key
 * and said so; 1 a governed commit is not verified, or the policy is
 * unreadable; 2 this check could not ask git the question at all (a shallow
 * clone, no repository, an ambiguous enforcement point) - which means the run
 * proves nothing rather than proving the commits are fine.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { devNull } from "node:os";
import { fileURLToPath } from "node:url";
import { ROOT } from "./registry.mjs";
import { loadSigningPolicy, SigningPolicyError, ENFORCEMENT_POINT_LITERAL } from "./signing-policy.mjs";

/**
 * The ONE value of git's `%G?` that is a verified signature.
 *
 * An allow-set of exactly one code, not a deny-list of the bad ones, and the
 * difference is the whole doctrine of this branch. `%G?` also answers U (good,
 * unknown validity), X (good, expired signature), Y (good, made by an expired
 * key), R (good, made by a REVOKED key), B (bad), E (cannot be checked) and N
 * (no signature at all). git documents FIVE of those eight with the word
 * "good" - G, U, X, Y and R - so four codes that are NOT this one are
 * nonetheless "good signatures", and one of those four is a signature by a
 * revoked key. None of them is a human identity this repository has bound
 * anything to. A deny-list would have to name each one, and a code git adds
 * later would arrive as an accept.
 */
const GOOD_SIGNATURE = "G";

/** What %x1f in the log format below writes between the four fields. */
const UNIT_SEPARATOR = "\u001f";

/** What each `%G?` code means, so an unverified commit says why in one line. */
const CODE_MEANING = {
  G: "a good signature",
  B: "a BAD signature",
  U: "a good signature with unknown validity",
  X: "a good signature that has expired",
  Y: "a good signature made by an expired key",
  R: "a good signature made by a REVOKED key",
  E: "a signature git could not check",
  N: "no signature at all",
};

/**
 * Whether one commit is bound to an accepted human identity, and if not, why.
 *
 * Pure, and separate from every git call above it, so that both of its
 * refusals can be witnessed by ordinary fixtures rather than by a repository
 * with real keys in it - which is not something a test in this repository
 * could build, and not something an agent may create.
 *
 * `record` is `{ sha, code, signer, key }`, read straight from
 * `%H`, `%G?`, `%GS` and `%GK`.
 */
export function classifyCommit(record, acceptedIdentities) {
  if (record.code !== GOOD_SIGNATURE) {
    return {
      verified: false,
      reason: `%G? = ${record.code} (${CODE_MEANING[record.code] ?? "a code this check does not know, which is not a verification"})`,
    };
  }
  const named = [record.signer, record.key].filter((value) => value !== "");
  if (!named.some((value) => acceptedIdentities.includes(value))) {
    return {
      verified: false,
      reason:
        `a good signature by ${named.join(" / ") || "an identity git did not name"}, ` +
        `which badf/signing-policy.yaml does not accept`,
    };
  }
  return { verified: true, reason: `a good signature by ${named.join(" / ")}` };
}

class GitUnavailable extends Error {}

/**
 * git's own supported way to rewrite history without rewriting a single
 * commit, and therefore the first thing this check has to switch off.
 *
 * `refs/replace` substitutes one object for another in every read git does.
 * `git replace --graft HEAD` writes a replacement HEAD with NO PARENTS, which
 * is the shallow-clone bypass above reproduced in a repository
 * `git rev-parse --is-shallow-repository` answers `false` for, with
 * `git rev-list --count HEAD` answering 1. The final review of this branch
 * drove it end to end: with a key enrolled and an unsigned commit touching
 * badf/authority.yaml, `SIGNING_CHECK FAIL 1 of 1` before the graft and
 * `SIGNING_CHECK PASS 0 commit(s)` after it - exit 0, having verified nothing,
 * with the shallow guard sitting right there answering the wrong question.
 * Writing a replacement ref needs nothing but ordinary git write access, which
 * is precisely what the actor this whole check exists to bind already has.
 *
 * So the DEFAULT IS INVERTED for the entire check rather than one more thing
 * being added to the list of things it refuses. `git for-each-ref refs/replace`
 * being non-empty was the other one-line answer and it is the worse of the two
 * three ways over: it is a list, so the next mechanism has to be remembered
 * and added; it is a check of a moment rather than of the reads that matter,
 * so a replacement written between it and the log call is not seen; and it
 * turns a repository whose replacements are legitimate into exit 2 - a run
 * that proves nothing - where this one still asks git the real question and
 * gets the real answer. Every git call in this file goes through this helper,
 * so there is no call site that can be added later and forget the flag.
 */
const NO_REPLACEMENT = "--no-replace-objects";

/**
 * The older mechanism `--no-replace-objects` does NOT reach: `.git/info/grafts`.
 *
 * DEC-029 recorded this as the sibling vector the review that added
 * `--no-replace-objects` left open, and a reviewer demonstrated it falsifies
 * that flag's own justification: writing HEAD's own sha into
 * `.git/info/grafts` produces the identical bypass - a repository with one
 * commit, `--is-shallow-repository` answering `false`, `--diff-filter=A`
 * reading every file as added in HEAD - and `git()` below still passed
 * `--no-replace-objects` on every call while doing so. Grafts and
 * `refs/replace` are two different features that happen to share a symptom;
 * `git replace --convert-graft-file` existing at all is git's own admission
 * that one does not subsume the other. `-c core.useReplaceRefs=false` was
 * tried too, side by side with the flag already here, against a real graft
 * file, in the throwaway repository this fix was reproduced in: neither
 * moved the bypass, because `core.useReplaceRefs` also governs `refs/replace`
 * only. What git 2.53 actually reads grafts from is the file named by the
 * `GIT_GRAFT_FILE` environment variable, defaulting to
 * `<GIT_DIR>/info/grafts`, and pointing that variable at the OS null device
 * makes every read see a graft file that is always empty, regardless of what
 * a write to the real path contains - the same "property of every read"
 * reasoning as the flag above, applied to the mechanism the flag does not
 * cover. (git also prints a `graftFileDeprecated` hint when the real file is
 * consulted; redirecting the read away from it removes the hint too, which
 * is a side effect, not the point.)
 */
const NO_GRAFTS = devNull;

function git(args) {
  const argv = [NO_REPLACEMENT, ...args];
  try {
    return execFileSync("git", argv, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_GRAFT_FILE: NO_GRAFTS },
    });
  } catch (error) {
    throw new GitUnavailable(
      `git ${argv.join(" ")} failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`,
    );
  }
}

/**
 * Refuses a repository whose history has been truncated.
 *
 * Everything below reads history to decide what is governed, and a truncated
 * history does not report itself as truncated - it reports fewer commits, and
 * a grafted root that every file appears to have been added in. Asking git
 * directly is the only honest way to tell the difference between "no governed
 * commit is unverified" and "no governed commit is visible from here".
 */
function refuseShallowHistory() {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {
    throw new GitUnavailable(
      "this is a SHALLOW repository, so its history is truncated and the " +
        "enforcement point cannot be resolved against it. In a shallow clone " +
        "every file reads as added in the grafted root commit, which would " +
        "silently anchor this check at HEAD and report that nothing needs " +
        "verifying. Clone with full history (fetch-depth: 0 in CI)",
    );
  }
}

/**
 * The commit the policy starts applying AFTER.
 *
 * The literal resolves to the commit that ADDED the policy, because the sha of
 * a commit cannot be written into the file that commit contains. Two adds - a
 * delete and a re-add - make the anchor ambiguous, and an ambiguous anchor is
 * one an agent could move forward by deleting and restoring a file, so it is
 * refused outright rather than resolved to the convenient one.
 */
function resolveEnforcementPoint(declared) {
  if (declared !== ENFORCEMENT_POINT_LITERAL) {
    git(["cat-file", "-e", `${declared}^{commit}`]);
    return declared;
  }
  const adds = git(["log", "--format=%H", "--diff-filter=A", "--", "badf/signing-policy.yaml"])
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (adds.length === 0) {
    throw new GitUnavailable(
      "no commit in this history adds badf/signing-policy.yaml, so the enforcement " +
        "point cannot be resolved. An uncommitted policy governs nothing; commit it, " +
        "or pin an explicit sha in enforcement_point",
    );
  }
  if (adds.length > 1) {
    throw new GitUnavailable(
      `${adds.length} commits add badf/signing-policy.yaml (${adds.join(", ")}), so the ` +
        `enforcement point is ambiguous. Deleting and restoring a file is how an ` +
        `anchor moves forward quietly; pin an explicit sha in enforcement_point`,
    );
  }
  return adds[0];
}

/**
 * Reads `git log`'s four-field records, refusing any line that is not four
 * fields.
 *
 * Exported and pure so the refusal has a fixture: a record this reader cannot
 * parse must not be silently dropped, because a DROPPED record is a governed
 * commit that never gets classified - it would leave the check reporting that
 * every commit it managed to read was fine, which is the same sentence as
 * "every commit was fine" and does not mean it.
 */
export function parseLogRecords(output) {
  const records = [];
  for (const line of String(output).split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const fields = line.split(UNIT_SEPARATOR);
    if (fields.length !== 4) {
      throw new GitUnavailable(
        `git log returned a record with ${fields.length} fields, not 4: ${line}`,
      );
    }
    records.push({ sha: fields[0], code: fields[1], signer: fields[2], key: fields[3] });
  }
  return records;
}

/**
 * Every commit after `point` that touched one of the protected paths.
 *
 * The range is EXCLUSIVE of the enforcement point. `${point}^..HEAD` would
 * retroactively govern the commit that added the policy - the one commit that
 * could not possibly have been signed under a policy it is introducing - and
 * nothing else in this file would notice.
 */
function governedCommits(point, protectedPaths) {
  return parseLogRecords(
    git([
      "log",
      "--format=%H%x1f%G?%x1f%GS%x1f%GK",
      `${point}..HEAD`,
      "--",
      ...protectedPaths,
    ]),
  );
}

function main() {
  let policy;
  try {
    policy = loadSigningPolicy();
  } catch (error) {
    if (error instanceof SigningPolicyError || error?.code === "ENOENT") {
      process.stderr.write(
        `SIGNING_CHECK FAIL badf/signing-policy.yaml: ${error.message}\n`,
      );
      return 1;
    }
    throw error;
  }

  let point;
  let commits;
  try {
    refuseShallowHistory();
    point = resolveEnforcementPoint(policy.enforcementPoint);
    commits = governedCommits(point, policy.protectedPaths);
  } catch (error) {
    if (error instanceof GitUnavailable) {
      process.stderr.write(
        `SIGNING_CHECK FAIL this check could not ask git the question, so it ` +
          `proves nothing about who wrote these records: ${error.message}\n`,
      );
      return 2;
    }
    throw error;
  }

  const accepted = policy.acceptedKeys.map((entry) => entry.identity);
  const unverified = [];
  for (const record of commits) {
    const verdict = classifyCommit(record, accepted);
    if (verdict.verified) continue;
    unverified.push(`${record.sha.slice(0, 12)} ${verdict.reason}`);
  }

  // Everything below reports. The ORDER matters: the unenforced state is
  // decided and returned before any line that could read as a pass, so that
  // "no key is enrolled" can never reach the PASS branch by any path.
  if (accepted.length === 0) {
    for (const line of unverified) {
      process.stderr.write(`SIGNING_CHECK UNVERIFIED ${line}\n`);
    }
    process.stderr.write(
      `SIGNING_CHECK NOT_ENFORCED badf/signing-policy.yaml enrols no key, so ` +
        `nothing in this repository is bound to a human identity. ` +
        `${commits.length} commit(s) after ${point.slice(0, 12)} touched the ` +
        `${policy.protectedPaths.length} protected path(s), of which ` +
        `${unverified.length} are bound to nobody - as every one of them must be, ` +
        `and every later one will be, while there is no accepted identity to be ` +
        `bound to. This is NOT a pass. Three human acts ` +
        `close it: enrol a key in accepted_keys, decide which identities count, ` +
        `and enable required_signatures branch protection on main. Of those ` +
        `three, badf/skills.yaml records exactly one - it records ` +
        `enroll-a-signing-key as FORBIDDEN_TO_AGENTS. The other two are named ` +
        `nowhere in this repository as forbidden to an agent, and this message ` +
        `no longer claims they are: one is a judgement and one happens on ` +
        `GitHub, so neither is a thing this check can observe. What it can say ` +
        `is that no agent may do the first, so this check reports rather than ` +
        `fails, and becomes a gate with no code change the moment a key is ` +
        `enrolled.\n`,
    );
    return 0;
  }

  if (unverified.length > 0) {
    for (const line of unverified) {
      process.stderr.write(`SIGNING_CHECK UNVERIFIED ${line}\n`);
    }
    process.stderr.write(
      `SIGNING_CHECK FAIL ${unverified.length} of ${commits.length} commit(s) after ` +
        `${point.slice(0, 12)} touched a path badf/signing-policy.yaml protects and ` +
        `are not signed by an accepted identity. A governance record whose author ` +
        `cannot be established is a record any agent could have written.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `SIGNING_CHECK PASS ${commits.length} commit(s) after ${point.slice(0, 12)} ` +
      `touched the ${policy.protectedPaths.length} protected path(s), every one ` +
      `signed by one of the ${accepted.length} accepted identity(ies)\n`,
  );
  return 0;
}

// Run only when invoked as a command, for the reason
// scripts/generate-codeowners.mjs carries the same guard: the tests import
// `classifyCommit` above to exercise the verification rules directly, and an
// import that shelled out to git as a side effect could not do that.
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`SIGNING_CHECK FAIL check defect: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}
