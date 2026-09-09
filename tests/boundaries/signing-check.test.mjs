/**
 * The signature check, witnessed - including the part that is deliberately not
 * enforcement yet.
 *
 * Every other check in this repository constrains what a record may SAY.
 * `scripts/check-signing.mjs` is the first one that asks who WROTE it, and it
 * cannot answer today: badf/signing-policy.yaml enrols no key, because
 * enrolling one is a human act. That makes the most important control in this
 * file the one that would ordinarily not exist - the control over the honest
 * reporting of an unenforced state.
 *
 * An unenforced control that prints nothing is indistinguishable from an
 * enforced one. That sentence is the whole defect class this branch has been
 * closing for five rounds, and it applies to this check most of all, because
 * this check will sit unenforced until a person acts. So NOT_ENFORCED is a
 * status of its own, it is asserted here, and `SIGNING_CHECK PASS` is asserted
 * ABSENT - a check that printed PASS while binding nothing would be worse than
 * no check at all.
 *
 * The two verification rules are exercised against `classifyCommit` directly.
 * Building a repository with real signatures in it would need key material,
 * and creating key material is precisely what no agent in this repository may
 * do - so the pure function is not a convenience here, it is the only way
 * these two rules can have a fixture at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSigningPolicy, loadSigningPolicy, SigningPolicyError } from "../../scripts/signing-policy.mjs";
import { classifyCommit } from "../../scripts/check-signing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-signing.mjs");

const POLICY = readFileSync(join(ROOT, "badf", "signing-policy.yaml"), "utf8");

/**
 * spawnSync, not execFileSync, and the reason is the behaviour under test.
 *
 * `execFileSync` hands back only stdout when the command SUCCEEDS - and the
 * NOT_ENFORCED status is written to stderr on an exit-0 run, which is exactly
 * the combination this file exists to assert. Written the other way, this
 * control read an empty string, could not see the status at all, and would
 * have gone green for a check that printed nothing: the defect class in the
 * test for the defect class.
 */
function run() {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status ?? -1,
    out: String(result.stdout ?? ""),
    err: String(result.stderr ?? ""),
  };
}

function refused(text, needle) {
  assert.throws(
    () => parseSigningPolicy(text),
    (error) => error instanceof SigningPolicyError && error.message.includes(needle),
    `expected a SigningPolicyError mentioning ${needle}; the reader accepted it ` +
      `instead, and a policy line a reader skips is a line a human reading the ` +
      `file still sees and believes`,
  );
}

test("the signing policy reader accepts this repository's own policy", () => {
  const policy = loadSigningPolicy();
  assert.ok(
    policy.protectedPaths.includes("badf/authority.yaml"),
    `the policy must protect the authority record; got ${policy.protectedPaths.join(", ")}`,
  );
  assert.equal(
    policy.acceptedKeys.length,
    0,
    "no key is enrolled in this repository, and a fixture that expected one " +
      "would be asserting a state no agent may bring about",
  );
});

test("a line the signing policy grammar does not classify is refused with its number", () => {
  // Three spaces: not a section, not an entry, not a field. The reader this
  // one is written after SKIPPED lines like it, and a peer review defeated it
  // five ways with ordinary, legal YAML.
  refused(POLICY.replace("  - badf/gates.yaml", "   - badf/gates.yaml"), "line ");
  refused(
    POLICY.replace("  - badf/gates.yaml", "\t- badf/gates.yaml"),
    "matches no rule of this policy's grammar",
  );
  refused(
    POLICY.replace("protected_paths:", "signatures_required: false\nprotected_paths:"),
    "matches no rule of this policy's grammar",
  );
});

test("a value the policy hands to git that is not the shape it must be is refused", () => {
  // git reads a leading dash as an OPTION, so this is the difference between
  // asking about eight paths and asking about every commit in the repository.
  refused(
    POLICY.replace("  - sessions/checkpoints", "  - sessions/checkpoints\n  - --all"),
    'protected path "--all" is not the shape it must be',
  );
  refused(
    POLICY.replace("enforcement_point: FIRST_COMMIT_OF_THIS_POLICY", "enforcement_point: --all"),
    'enforcement_point "--all" is not the shape it must be',
  );
});

test("only a %G? of G is read as a verified signature", () => {
  // Four of git's eight codes contain the word "good" and not one of them is
  // an identity this repository has bound anything to. R is the sharp case: a
  // good signature made by a REVOKED key.
  const accepted = ["A Human <human@example.invalid>"];
  for (const code of ["B", "U", "X", "Y", "R", "E", "N", "Z"]) {
    const verdict = classifyCommit(
      { sha: "0".repeat(40), code, signer: "A Human <human@example.invalid>", key: "KEYID" },
      accepted,
    );
    assert.equal(
      verdict.verified,
      false,
      `%G? = ${code} must not be read as a verified signature, whatever else it ` +
        `is; got ${JSON.stringify(verdict)}`,
    );
    assert.match(verdict.reason, new RegExp(`%G\\? = ${code}`), verdict.reason);
  }
  assert.equal(
    classifyCommit(
      { sha: "0".repeat(40), code: "G", signer: "A Human <human@example.invalid>", key: "" },
      accepted,
    ).verified,
    true,
    "a good signature by an accepted identity must verify, or the loop above " +
      "proves nothing but that this function always says no",
  );
});

test("a good signature by an identity the policy does not accept is not verified", () => {
  const verdict = classifyCommit(
    { sha: "0".repeat(40), code: "G", signer: "Someone Else <else@example.invalid>", key: "OTHER" },
    ["A Human <human@example.invalid>"],
  );
  assert.equal(
    verdict.verified,
    false,
    "a signature is only a binding to the identity the policy accepted; any " +
      "good signature counting would make the check a check that the committer " +
      "owns a key, which every agent could be given",
  );
  assert.match(verdict.reason, /does not accept/, verdict.reason);
});

test("an accepted identity matching git's key id rather than its signer is verified", () => {
  // %GS is the signer's name, %GK the key. A policy may enrol either, because
  // an SSH signature often names only the key.
  assert.equal(
    classifyCommit(
      { sha: "0".repeat(40), code: "G", signer: "Unnamed", key: "SHA256:abcdef" },
      ["SHA256:abcdef"],
    ).verified,
    true,
  );
});

test("the signing check reports NOT_ENFORCED, and never PASS, while no key is enrolled", () => {
  const { code, out, err } = run();
  const combined = out + err;
  assert.equal(
    code,
    0,
    `an unenrolled policy is not a failure state an agent can remedy, so this ` +
      `check reports rather than fails; got ${code}:\n${combined}`,
  );
  assert.match(
    err,
    /SIGNING_CHECK NOT_ENFORCED/,
    `the unenforced state must announce itself in a distinct, greppable status. ` +
      `A control that prints nothing while binding nothing is indistinguishable ` +
      `from one that is enforced, which is the defect this check exists to ` +
      `close:\n${combined}`,
  );
  assert.ok(
    !combined.includes("SIGNING_CHECK PASS"),
    `SIGNING_CHECK PASS must be unreachable while accepted_keys enrols nobody - ` +
      `a pass line here would assert a human binding that does not exist:\n${combined}`,
  );
  assert.match(
    err,
    /enroll-a-signing-key as FORBIDDEN_TO_AGENTS/,
    `the message must name why no agent can clear this state, or the next agent ` +
      `reads it as a task list:\n${combined}`,
  );
});

test("pnpm verify runs the signing check", () => {
  // A check that is not in the chain is a file. This is the one assertion that
  // keeps the whole of the above from becoming decorative in one edit.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:signing"], "node scripts/check-signing.mjs");
  assert.ok(
    pkg.scripts.verify.includes("pnpm check:signing"),
    `pnpm verify must run the signing check; got: ${pkg.scripts.verify}`,
  );
});
