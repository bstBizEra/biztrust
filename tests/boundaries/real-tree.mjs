/**
 * "Is the REAL repository's working tree clean, and if not, what does that
 * mean for a test that spawns `scripts/mutation-check.mjs`?"
 *
 * Round four finding I10. Three tests in this directory spawn the real
 * `scripts/mutation-check.mjs`, and that script refuses to start at all when
 * `git status --porcelain` against the real repository is non-empty (exit 2,
 * "the working tree is not clean"). So on ANY dirty tree - including the tree
 * of the person part-way through fixing a finding the suite itself reported -
 * `pnpm test:boundaries` went red, under test names that claim something
 * quite different:
 *
 *   "mutation-check fails the run if the working tree is dirty at exit"
 *   "finding 1: a failure after `git worktree add` succeeds leaves no worktree behind"
 *   "finding 2: a later run reclaims a worktree orphaned by an earlier killed run"
 *
 * None of those had failed. Their PRECONDITION was unmet, and a red test
 * that says one thing and means another is worse than a skipped one: the
 * next reader debugs the wrong thing, or learns to ignore the suite. These
 * tests now skip, with the reason and the offending `git status` output
 * printed, which is what an unmet precondition actually is.
 *
 * The check is made INSIDE `withRealRootLock` by every caller, not at module
 * load: `node --test` runs test FILES in parallel, and one of these very
 * tests deliberately dirties the real tree for a moment to witness the guard.
 * Reading the tree's state outside the lock would let that momentary,
 * expected dirt be mistaken for the operator's own uncommitted work and skip
 * a test that could have run.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REAL_ROOT = join(HERE, "..", "..");

/** `git status --porcelain` against the REAL repository - the same command,
 * against the same tree, that `scripts/mutation-check.mjs`'s own guard runs. */
export function realTreeStatus() {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: REAL_ROOT,
    encoding: "utf8",
  });
}

/**
 * The witness files these tests deliberately create to dirty the real tree,
 * as a pattern rather than a fixed name (each carries the writing process's
 * pid and a random suffix - see mutation-check-guard.test.mjs for why a fixed
 * name reproduced the very race that file exists to close).
 */
const WITNESS_PATTERN = /^\.mutation-check-(?:dirty|exit)-guard-witness\..+\.tmp$/;

/**
 * Removes witness files left behind by an EARLIER, interrupted run of these
 * tests, from both directories one can be written to.
 *
 * A killed test process (Ctrl-C, a torn-down CI job) skips the `finally` that
 * removes its witness, and the leftover then dirties the real tree
 * permanently - which wedges `pnpm check:mutations` on every later run, since
 * that script's start guard refuses a dirty tree. Same shape, and same fix,
 * as `reclaimOrphanWorktrees` in `scripts/mutation-check.mjs`: the next run
 * reclaims what an interrupted one could not.
 *
 * Deliberately NOT done by adding these names to `.gitignore`, which was the
 * first idea and is wrong: `git status --porcelain` does not report an
 * ignored file, so ignoring the witness would make the START-half guard test
 * unable to dirty the tree at all - the control would pass whether or not the
 * guard existed, which is precisely the defect class this round is closing.
 * The reclamation is done here, in test code, called only from inside
 * `withRealRootLock` so it can never race a live witness.
 */
export function reclaimStaleWitnesses() {
  for (const dir of [HERE, REAL_ROOT]) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!WITNESS_PATTERN.test(entry)) continue;
      try {
        rmSync(join(dir, entry), { force: true });
      } catch {
        // best-effort; the skip below still reports the tree as dirty
      }
    }
  }
}

/**
 * Reclaims stale witnesses, then reports whether the real tree is clean
 * enough for a test that spawns `scripts/mutation-check.mjs` to prove
 * anything at all. Marks `t` skipped and returns true when it is not.
 *
 * Call from INSIDE `withRealRootLock`, and return immediately when it
 * returns true.
 */
export function skipIfRealTreeIsDirty(t) {
  reclaimStaleWitnesses();
  const dirt = realTreeStatus();
  if (dirt.trim() === "") return false;
  t.skip(
    `the real working tree is not clean, so scripts/mutation-check.mjs ` +
      `refuses to start (exit 2, "the working tree is not clean") and this ` +
      `test's precondition cannot be met. This is an unmet precondition, not ` +
      `a failure of the behaviour under test. Commit or stash first. ` +
      `git status --porcelain said:\n${dirt}`,
  );
  return true;
}
