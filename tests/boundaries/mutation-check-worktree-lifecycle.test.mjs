/**
 * The lifecycle of the disposable `git worktree` `scripts/mutation-check.mjs`
 * mutates and tests against (see the top of that script for why it exists:
 * mutating the tracked `scripts/boundary-rules.mjs` / `scripts/migration-lint.mjs`
 * in place, restoring in a `finally`, left a loosened rule behind on an
 * interrupted run).
 *
 * Peer review of that fix found the worktree lifecycle itself was not safe
 * against exactly the kind of interruption the fix exists to tolerate:
 *
 *   - FINDING 1: creation was not atomic. `git worktree add` can succeed and
 *     a later step (the node_modules link) can still fail; before this fix,
 *     that left a full checkout registered in `git worktree list` and on
 *     disk with no cleanup attempt at all. Reproduced by the reviewer
 *     forcing the link step to throw right after `add` succeeded.
 *
 *   - FINDING 2: stale-worktree cleanup was not robust to a killed run.
 *     `git worktree prune` does not remove a worktree whose directory still
 *     exists - only the admin bookkeeping for one whose directory is
 *     already gone - so a `kill -9` mid-sweep (which skips every `finally`)
 *     leaked another full checkout, forever, once per interruption, with
 *     nothing telling the operator. Reproduced by the reviewer SIGKILLing a
 *     live run.
 *
 * Both tests below spawn the real script - not a reimplementation of its
 * worktree logic - using small TEST-ONLY env-var seams in
 * `scripts/mutation-check.mjs` (`MUTATION_CHECK_TEST_FAIL_AFTER_ADD`,
 * `MUTATION_CHECK_TEST_KILL_AFTER_ADD`) to land deterministically in the
 * exact failure windows the reviewer found by hand, rather than racing real
 * process-kill timing inside an automated test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(ROOT, "scripts", "mutation-check.mjs");

/** Same recursion guard as tests/boundaries/mutation-check-guard.test.mjs -
 * see that file for why: this file is part of the `tests/boundaries/*.test.mjs`
 * glob that `check:mutations` re-runs per mutation, and both tests here spawn
 * a fresh `mutation-check.mjs` of their own. */
const skip =
  process.env.MUTATION_CHECK_RUNNING === "1"
    ? "avoids recursing into a nested mutation-check sweep while already inside one"
    : false;

/** The worktree paths `git worktree list` currently knows about, main
 * worktree included, in the stable order git reports them. */
function listWorktreePaths() {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** Runs the real script with extra env vars layered onto this process's own
 * environment, and returns { code, out } the same way every other spawn
 * helper in this suite does. */
function runScript(env) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test(
  "finding 1: a failure after `git worktree add` succeeds leaves no worktree behind",
  { skip },
  () => {
    const before = listWorktreePaths();

    const result = runScript({ MUTATION_CHECK_TEST_FAIL_AFTER_ADD: "1" });

    assert.equal(
      result.code,
      2,
      `expected the script to fail closed (exit 2) when creation fails after ` +
        `\`git worktree add\` succeeds; got ${result.code}:\n${result.out}`,
    );
    assert.match(
      result.out,
      /could not create an isolated worktree/i,
      `expected the createWorktree failure message; got:\n${result.out}`,
    );

    const after = listWorktreePaths();
    assert.deepEqual(
      after,
      before,
      `expected \`git worktree list\` to be unchanged after a forced failure ` +
        `post-\`git worktree add\` (no leaked worktree); before=${JSON.stringify(before)} ` +
        `after=${JSON.stringify(after)}`,
    );
  },
);

test(
  "finding 2: a later run reclaims a worktree orphaned by an earlier killed run",
  { skip },
  () => {
    const before = listWorktreePaths();

    // Simulate the kill: the worktree is fully formed (checked out, owner
    // file written, node_modules linked) when the process exits without
    // running any cleanup - see MUTATION_CHECK_TEST_KILL_AFTER_ADD in
    // scripts/mutation-check.mjs for exactly where.
    const killed = runScript({ MUTATION_CHECK_TEST_KILL_AFTER_ADD: "1" });
    assert.equal(
      killed.code,
      137,
      `expected the simulated-kill run to exit with the code it set itself ` +
        `right before exiting (137); got ${killed.code}:\n${killed.out}`,
    );

    const afterKill = listWorktreePaths();
    const orphans = afterKill.filter((p) => !before.includes(p));
    assert.equal(
      orphans.length,
      1,
      `expected exactly one new worktree left behind by the simulated kill; ` +
        `before=${JSON.stringify(before)} afterKill=${JSON.stringify(afterKill)}`,
    );
    const [orphan] = orphans;
    assert.ok(
      existsSync(orphan),
      `the orphaned worktree's directory must still exist on disk after the ` +
        `kill - that is the entire point of this test (a REAL kill skips every ` +
        `\`finally\`, so nothing removed it): ${orphan}`,
    );

    // A later, ordinary run must find and reclaim that orphan on its own,
    // before creating its own worktree - and must otherwise succeed
    // normally. MUTATION_CHECK_TEST_LIMIT keeps this fast: reclamation does
    // not depend on how many mutations run afterward.
    const reclaiming = runScript({ MUTATION_CHECK_TEST_LIMIT: "0" });
    assert.equal(
      reclaiming.code,
      0,
      `expected the follow-up run to succeed cleanly; got ${reclaiming.code}:\n${reclaiming.out}`,
    );
    assert.ok(
      reclaiming.out.includes("reclaiming an orphaned worktree") && reclaiming.out.includes(orphan),
      `expected the follow-up run to report reclaiming exactly the orphaned ` +
        `worktree left by the killed run (${orphan}); got:\n${reclaiming.out}`,
    );
    assert.ok(
      !existsSync(orphan),
      `expected the orphan's directory to be gone from disk after reclamation: ${orphan}`,
    );

    const afterReclaim = listWorktreePaths();
    assert.deepEqual(
      afterReclaim,
      before,
      `expected \`git worktree list\` to be back to exactly what it was before ` +
        `this test, orphan included and gone; before=${JSON.stringify(before)} ` +
        `afterReclaim=${JSON.stringify(afterReclaim)}`,
    );
  },
);
