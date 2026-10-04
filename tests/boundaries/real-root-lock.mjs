/**
 * A cross-process mutex over "the REAL repository's working tree is clean
 * and nobody else is depending on that right now."
 *
 * `scripts/mutation-check.mjs`'s dirty-tree guard reads `git status
 * --porcelain` against the actual, top-level repository - not any worktree -
 * both at start and at exit. Several tests in this directory spawn the real
 * script and either deliberately dirty that real tree for a moment (the
 * start/exit guard witnesses in mutation-check-guard.test.mjs) or simply
 * need it to STAY clean while their own spawn's start check runs (the
 * worktree-lifecycle witnesses in mutation-check-worktree-lifecycle.test.mjs).
 *
 * `node --test "tests/boundaries/*.test.mjs"` runs test FILES in parallel -
 * the exact hazard this whole task exists to close one level down, in the
 * suites themselves - so without serialising these specific tests against
 * each other, one test's deliberate, momentary dirtying of the real tree can
 * be observed by a DIFFERENT test's concurrently-spawned script instance,
 * which then takes the wrong code path and fails for a reason that has
 * nothing to do with the behaviour it is trying to prove. Reproduced during
 * development: running the full glob made `mutation-check-guard.test.mjs`'s
 * start-guard witness and `mutation-check-worktree-lifecycle.test.mjs`'s
 * finding-1 witness collide exactly this way on the first attempt.
 *
 * This does NOT protect the worktree-lifecycle tests' own worktrees from
 * each other or from anything else - that is what
 * `MUTATION_CHECK_TEST_WORKTREE_TAG` is for (see that file). It protects
 * only the one thing every one of these tests shares: the real tree's own
 * clean/dirty state at the moment a spawned script's guard reads it.
 */

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LOCK_DIR = join(tmpdir(), "biztrust-mutation-check-real-root-lock");

/** A synchronous sleep. `Atomics.wait` blocks the calling thread (including
 * Node's main thread, unlike a browser main thread) without needing an
 * async callback or a worker - appropriate here since every caller of
 * `withRealRootLock` is already a synchronous test body built around
 * `spawnSync`. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` while holding the lock, waiting (polling) for it if another test
 * process currently holds it, and always releasing it afterward - success,
 * thrown assertion, or any other error alike.
 *
 * `mkdirSync` on a path that already exists throws EEXIST; creating a
 * directory is atomic at the filesystem level, which is what makes this
 * safe as a mutex across separate OS processes (these are separate `node
 * --test` test files, each its own process), not just separate async tasks
 * in one process.
 */
export function withRealRootLock(fn, { timeoutMs = 60000, pollMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(LOCK_DIR);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for the real-root test lock ` +
            `at ${LOCK_DIR} - either a very slow run or a stale lock left by a ` +
            `killed test process; remove that directory to recover`,
        );
      }
      sleepSync(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
