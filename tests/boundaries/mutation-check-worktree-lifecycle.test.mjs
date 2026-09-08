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
 *
 * Each test tags its own spawns with a fresh, random
 * `MUTATION_CHECK_TEST_WORKTREE_TAG` and only ever inspects worktrees under
 * that tag, rather than diffing the WHOLE `git worktree list`. This is not
 * decorative: `node --test` runs test FILES in parallel, so this file's
 * "finding 2" case - which deliberately leaves a real orphan behind - runs
 * concurrently with, among others, `mutation-check-guard.test.mjs`'s own
 * spawned `mutation-check.mjs` invocations. Without a tag, both use the SAME
 * default worktree prefix, and the exit-guard test's spawn calls the exact
 * same `reclaimOrphanWorktrees()` this file is trying to observe - it would
 * legitimately reclaim this file's orphan first, out from under it, making
 * this test fail non-deterministically depending on scheduling. Confirmed by
 * running the full `tests/boundaries/*.test.mjs` glob during development:
 * this exact race reproduced on the first attempt with a shared prefix.
 *
 * A second, narrower race showed up the same way, one layer down: every
 * test here spawns a script instance that reads the REAL repository's `git
 * status --porcelain` as ITS OWN start check, and
 * mutation-check-guard.test.mjs's tests deliberately dirty that same real
 * tree for a moment to witness that check. Running concurrently, a
 * `finding 1`/`finding 2` spawn here can land its start check exactly inside
 * that window and see a dirty tree that has nothing to do with either test.
 * Both files now serialise the specific tests that touch this shared state
 * through `withRealRootLock` (see real-root-lock.mjs) so this cannot happen,
 * without slowing down or otherwise touching anything else in the suite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { withRealRootLock } from "./real-root-lock.mjs";

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

/** A fresh tag for one test's spawns - see the top-of-file comment for why
 * this exists. Effectively unique: collision would need another process to
 * independently generate the same 8 random hex characters in the same test
 * run. */
function freshTag() {
  return randomBytes(4).toString("hex");
}

/** The `git worktree list` paths under this specific tag's prefix, in the
 * order git reports them. Scoping to the tag (rather than diffing the whole
 * list) is what makes this immune to unrelated worktrees - a sibling test
 * file's own concurrent spawns included - appearing or disappearing during
 * the window between two calls. */
function taggedWorktreePaths(tag) {
  const prefix = join(tmpdir(), `biztrust-mutation-test-${tag}-`).replace(/\\/g, "/");
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((path) => path.replace(/\\/g, "/").startsWith(prefix));
}

/** Runs the real script with extra env vars layered onto this process's own
 * environment, and returns { code, out }. Uses `spawnSync` rather than
 * `execFileSync`: the reclaim message (like most of this script's
 * diagnostics) goes to stderr, and `execFileSync`'s return value on a
 * SUCCESSFUL run carries only stdout - `spawnSync` reports both streams
 * unconditionally, on success or failure alike, which every assertion below
 * that reads a stderr-only message depends on. */
function runScript(env) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

test(
  "finding 1: a failure after `git worktree add` succeeds leaves no worktree behind",
  { skip },
  () => {
    withRealRootLock(() => {
      const tag = freshTag();

      const result = runScript({
        MUTATION_CHECK_TEST_FAIL_AFTER_ADD: "1",
        MUTATION_CHECK_TEST_WORKTREE_TAG: tag,
      });

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

      const leaked = taggedWorktreePaths(tag);
      assert.deepEqual(
        leaked,
        [],
        `expected no worktree left registered under this test's own tag after a ` +
          `forced failure post-\`git worktree add\`; found: ${JSON.stringify(leaked)}`,
      );
    });
  },
);

test(
  "finding 2: a later run reclaims a worktree orphaned by an earlier killed run",
  { skip },
  () => {
    withRealRootLock(() => {
      const tag = freshTag();

      // Simulate the kill: the worktree is fully formed (checked out, owner
      // file written, node_modules linked) when the process exits without
      // running any cleanup - see MUTATION_CHECK_TEST_KILL_AFTER_ADD in
      // scripts/mutation-check.mjs for exactly where.
      const killed = runScript({
        MUTATION_CHECK_TEST_KILL_AFTER_ADD: "1",
        MUTATION_CHECK_TEST_WORKTREE_TAG: tag,
      });
      assert.equal(
        killed.code,
        137,
        `expected the simulated-kill run to exit with the code it set itself ` +
          `right before exiting (137); got ${killed.code}:\n${killed.out}`,
      );

      const orphans = taggedWorktreePaths(tag);
      assert.equal(
        orphans.length,
        1,
        `expected exactly one worktree left behind under this test's own tag by ` +
          `the simulated kill; found: ${JSON.stringify(orphans)}`,
      );
      const [orphan] = orphans;
      assert.ok(
        existsSync(orphan),
        `the orphaned worktree's directory must still exist on disk after the ` +
          `kill - that is the entire point of this test (a REAL kill skips every ` +
          `\`finally\`, so nothing removed it): ${orphan}`,
      );

      // A later, ordinary run - tagged the SAME way, so it scans the same
      // namespace this orphan lives in - must find and reclaim that orphan on
      // its own, before creating its own worktree, and must otherwise succeed
      // normally. MUTATION_CHECK_TEST_LIMIT keeps this fast: reclamation does
      // not depend on how many mutations run afterward.
      const reclaiming = runScript({
        MUTATION_CHECK_TEST_LIMIT: "0",
        MUTATION_CHECK_TEST_WORKTREE_TAG: tag,
      });
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

      const remaining = taggedWorktreePaths(tag);
      assert.deepEqual(
        remaining,
        [],
        `expected no worktree left registered under this test's own tag once the ` +
          `follow-up run has created and torn down its own; found: ${JSON.stringify(remaining)}`,
      );
    });
  },
);
