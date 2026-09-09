/**
 * `scripts/check-signing.mjs`'s git plumbing, against real git histories.
 *
 * WHY THIS IS A SUITE OF ITS OWN, in its own directory rather than under
 * tests/boundaries/. Every control here builds a throwaway repository, makes
 * two or three commits in it and spawns the check - a few hundred milliseconds
 * apiece, where a boundary control is a fraction of one. `pnpm check:mutations`
 * runs a whole suite once PER MUTATION, and there are over a hundred boundary
 * mutations, so adding these to that glob would have added minutes to every
 * `pnpm verify` for controls not one of those mutations can move. The eight
 * mutations that do move them name `suite: "signing"` and pay for this file
 * alone. The precedent is the `validator` suite, split from the boundary suite
 * for exactly this reason.
 *
 * WHY IT EXISTS AT ALL. The first version of this task witnessed
 * `classifyCommit` thoroughly and the plumbing around it not at all, and the
 * report said so - claiming a fixture would need key material no agent may
 * create. Review disproved that in under a minute: the PASS-with-a-real-
 * signature case needs a key, and NOTHING ELSE HERE DOES. Four refusals and
 * two reporting branches were reachable with no key at all, including the one
 * that stops an agent moving the enforcement point past its own forgery by
 * deleting and re-adding the policy. Review also found, in this gap, a
 * CRITICAL bypass: a shallow clone resolves the enforcement point to its own
 * grafted root - that is, to HEAD - and the check reported PASS having
 * verified nothing.
 *
 * What still has no fixture is the one case that genuinely needs key material:
 * a real signature verifying against a real enrolled identity. `classifyCommit`
 * decides that in tests/boundaries/signing-check.test.mjs, and an independent
 * review drove it end-to-end with an SSH key in a throwaway clone. It is
 * recorded as a gap rather than mocked, because a fixture asserting against
 * this file's own fabricated `%G?` output would be testing the fabrication.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseLogRecords } from "../../scripts/check-signing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/** The three files the check needs to run anywhere. */
const CARRIED = ["registry.mjs", "signing-policy.mjs", "check-signing.mjs"];

const POLICY = readFileSync(join(ROOT, "badf", "signing-policy.yaml"), "utf8");

/**
 * The same policy with one identity enrolled.
 *
 * A FIXTURE, in a throwaway repository, naming an identity that is not a key
 * and belongs to nobody. It enrols nothing in this repository: no agent may do
 * that, and badf/skills.yaml records enroll-a-signing-key as
 * FORBIDDEN_TO_AGENTS. It exists because the ENFORCED branches - PASS, and the
 * FAIL that is the whole point of the check - are unreachable while
 * accepted_keys says NONE_ENROLLED, and an unreachable branch is an unwitnessed
 * one.
 */
const POLICY_WITH_KEY = POLICY.replace(
  "accepted_keys: NONE_ENROLLED",
  ["accepted_keys:", '  - identity: "A Human <human@example.invalid>"', "    kind: ssh", "    enrolled_by: repository-administrator"].join("\n"),
);

function git(dir, args) {
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `fixture setup failed: git ${args.join(" ")}\n${result.stdout}${result.stderr}`,
  );
  return result.stdout;
}

/** Runs the check inside `dir`, capturing BOTH streams - the statuses that
 * matter most here are written to stderr on an exit-0 run. */
function check(dir) {
  const result = spawnSync(process.execPath, [join(dir, "scripts", "check-signing.mjs")], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    code: result.status ?? -1,
    output: String(result.stdout ?? "") + String(result.stderr ?? ""),
  };
}

/**
 * A throwaway repository carrying the check, with ONE commit that touches no
 * protected path. `fn` receives its directory and adds whatever history the
 * control is about.
 */
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "biztrust-signing-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "badf"), { recursive: true });
    for (const name of CARRIED) {
      copyFileSync(join(ROOT, "scripts", name), join(dir, "scripts", name));
    }
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["config", "user.name", "Fixture"]);
    git(dir, ["config", "user.email", "fixture@example.invalid"]);
    // Never inherit a real signing configuration into a fixture: these commits
    // must be unsigned, and an operator with commit.gpgsign=true globally would
    // otherwise make three of these controls pass for the wrong reason.
    git(dir, ["config", "commit.gpgsign", "false"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "the check, before any policy exists"]);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Writes the policy into the working tree, uncommitted. The directory is
 * recreated because `git rm` of the only file in it removes it, and the
 * delete-and-re-add control needs to put it back. */
function writePolicy(dir, text) {
  mkdirSync(join(dir, "badf"), { recursive: true });
  writeFileSync(join(dir, "badf", "signing-policy.yaml"), text, "utf8");
}

/** Writes the policy and commits it - the commit that becomes the enforcement point. */
function commitPolicy(dir, text = POLICY) {
  writePolicy(dir, text);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "add the signing policy"]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

test("a shallow clone is refused, not silently anchored at its own grafted root", () => {
  // THE CRITICAL FINDING. In a shallow clone the root has no parent, so every
  // file reads as ADDED there and `git log --diff-filter=A` returns exactly one
  // sha: HEAD. Neither the no-adds nor the ambiguous-adds refusal fires, the
  // enforcement point becomes HEAD, and with a key enrolled the check printed
  // SIGNING_CHECK PASS having verified nothing whatsoever. The only thing that
  // had stood between this repository and that was one line of CI YAML that no
  // control named.
  fixture((dir) => {
    commitPolicy(dir, POLICY_WITH_KEY);
    writeFileSync(join(dir, "badf", "authority.yaml"), "version: \"0.1.0\"\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "a change to a protected path, unsigned"]);

    const clone = mkdtempSync(join(tmpdir(), "biztrust-signing-shallow-"));
    try {
      const result = spawnSync(
        "git",
        ["clone", "-q", "--depth", "1", "-b", "main", pathToFileURL(dir).href, clone],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, `fixture clone failed:\n${result.stdout}${result.stderr}`);
      assert.equal(
        git(clone, ["rev-parse", "--is-shallow-repository"]).trim(),
        "true",
        "the fixture must actually be shallow, or this control proves nothing",
      );

      const { code, output } = check(clone);
      assert.equal(code, 2, `a truncated history must be refused outright:\n${output}`);
      assert.match(output, /SHALLOW repository/, output);
      assert.ok(
        !output.includes("SIGNING_CHECK PASS"),
        `a shallow clone must never reach a pass line - it is the exact shape of ` +
          `a check that verified nothing and said everything was fine:\n${output}`,
      );
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });
});

test("a policy no commit has added is refused rather than resolved to something", () => {
  fixture((dir) => {
    writePolicy(dir, POLICY); // present in the tree, never committed
    const { code, output } = check(dir);
    assert.equal(code, 2, output);
    assert.match(output, /no commit in this history adds/, output);
  });
});

test("an enforcement point two commits both claim is refused as ambiguous", () => {
  // The anti-forgery refusal named in this task's own report: deleting and
  // restoring the policy is how an agent moves the enforcement point PAST its
  // own forgery. Without this control the refusal could be deleted with
  // `pnpm verify` still green at every mutation.
  fixture((dir) => {
    commitPolicy(dir);
    git(dir, ["rm", "-q", "badf/signing-policy.yaml"]);
    git(dir, ["commit", "-q", "-m", "delete the policy"]);
    commitPolicy(dir);

    const { code, output } = check(dir);
    assert.equal(code, 2, `an ambiguous anchor must be refused, not resolved:\n${output}`);
    assert.match(output, /enforcement point is ambiguous/, output);
  });
});

test("the enforcement point is exclusive: the commit that added the policy is not governed", () => {
  // That commit is the one commit that could not possibly have been signed
  // under a policy it is introducing, and `${point}^..HEAD` would demand it.
  fixture((dir) => {
    commitPolicy(dir, POLICY_WITH_KEY);
    const { code, output } = check(dir);
    assert.equal(code, 0, `the policy's own commit must not be governed by it:\n${output}`);
    assert.match(output, /SIGNING_CHECK PASS 0 commit\(s\)/, output);
  });
});

test("an unsigned commit touching a protected path fails once an identity is enrolled", () => {
  // The branch the whole check exists for, and it needs no key: an UNSIGNED
  // commit is %G? = N, and N is not G.
  fixture((dir) => {
    commitPolicy(dir, POLICY_WITH_KEY);
    writeFileSync(join(dir, "badf", "authority.yaml"), "version: \"0.1.0\"\n", "utf8");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "forge a grant"]);

    const { code, output } = check(dir);
    assert.equal(code, 1, `an unverified governed commit must FAIL:\n${output}`);
    assert.match(output, /SIGNING_CHECK FAIL 1 of 1 commit\(s\)/, output);
    assert.match(output, /not signed by an accepted identity/, output);
    assert.ok(
      !output.includes("SIGNING_CHECK PASS"),
      `a run with an unverified commit must not also print a pass line:\n${output}`,
    );
  });
});

test("a policy the reader cannot read fails the check rather than passing it", () => {
  fixture((dir) => {
    commitPolicy(dir, POLICY.replace("protected_paths:", "\tprotected_paths:"));
    const { code, output } = check(dir);
    assert.equal(code, 1, `an unreadable policy is a data defect, not a pass:\n${output}`);
    assert.match(output, /SIGNING_CHECK FAIL badf\/signing-policy\.yaml/, output);
  });
});

test("a git command that fails is reported as a check that could not run", () => {
  // Not a repository at all. "I could not ask" and "the answer was fine" are
  // different sentences, and a check that conflates them is worthless in
  // exactly the environments where it matters - a CI runner, a tarball, a
  // container built without .git.
  const dir = mkdtempSync(join(tmpdir(), "biztrust-signing-nogit-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "badf"), { recursive: true });
    for (const name of CARRIED) copyFileSync(join(ROOT, "scripts", name), join(dir, "scripts", name));
    writePolicy(dir, POLICY);

    const { code, output } = check(dir);
    assert.equal(code, 2, output);
    assert.match(output, /could not ask git the question, so it proves nothing/, output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a git log record this check cannot parse is refused, never dropped", () => {
  // The unit separator %x1f the log format writes between the four fields.
  const sep = "\u001f";
  assert.deepEqual(
    parseLogRecords(["abc", "G", "A Human", "KEY"].join(sep)),
    [{ sha: "abc", code: "G", signer: "A Human", key: "KEY" }],
  );
  assert.throws(
    () => parseLogRecords(["abc", "G", "A Human"].join(sep)),
    /fields, not 4/,
    "a record with the wrong shape must be refused. Dropping it would leave a " +
      "governed commit unclassified while the check reported that everything it " +
      "managed to read was fine",
  );
});
