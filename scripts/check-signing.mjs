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
 * Exit codes: 0 every governed commit verified, or the policy enrols no key
 * and said so; 1 a governed commit is not verified, or the policy is
 * unreadable; 2 this check could not ask git the question at all (a shallow
 * clone, no repository, an ambiguous enforcement point) - which means the run
 * proves nothing rather than proving the commits are fine.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ROOT } from "./registry.mjs";
import { loadSigningPolicy, SigningPolicyError, ENFORCEMENT_POINT_LITERAL } from "./signing-policy.mjs";

/**
 * The ONE value of git's `%G?` that is a verified signature.
 *
 * An allow-set of exactly one code, not a deny-list of the bad ones, and the
 * difference is the whole doctrine of this branch. `%G?` also answers U (good,
 * but the key is untrusted), X (good, expired signature), Y (good, made by an
 * expired key), R (good, made by a REVOKED key), B (bad), E (cannot be
 * checked) and N (no signature at all). Four of those eight contain the word
 * "good" and none of them is a human identity this repository has bound
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
  U: "a good signature by an untrusted key",
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

function git(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new GitUnavailable(
      `git ${args.join(" ")} failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`,
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

/** Every commit after `point` that touched one of the protected paths. */
function governedCommits(point, protectedPaths) {
  const output = git([
    "log",
    "--format=%H%x1f%G?%x1f%GS%x1f%GK",
    `${point}..HEAD`,
    "--",
    ...protectedPaths,
  ]);
  const records = [];
  for (const line of output.split(/\r?\n/)) {
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
        `and enable required_signatures branch protection on main. No agent may ` +
        `do any of the three - badf/skills.yaml records enroll-a-signing-key as ` +
        `FORBIDDEN_TO_AGENTS - so this check reports rather than fails, and ` +
        `becomes a gate with no code change the moment a key is enrolled.\n`,
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
