/**
 * The dirty-tree guard on `scripts/mutation-check.mjs` - BOTH halves.
 *
 * `mutation-check.mjs` used to mutate the tracked `scripts/boundary-rules.mjs`
 * and `scripts/migration-lint.mjs` in place, restoring in a `finally`. An
 * interrupted run left a loosened rule sitting in a tracked source file. It
 * now runs entirely against a disposable `git worktree` copy of HEAD instead
 * (see the top of that script), and:
 *
 *   1. refuses to start at all if the real working tree is not clean - there
 *      would be nothing safe to check out (the START half); and
 *   2. fails the run - even one where every mutation was individually caught
 *      - if the real working tree is dirty once the sweep is done (the EXIT
 *      half). A PASS must mean the tracked source was never touched, not
 *      merely that it was touched and successfully restored.
 *
 * A guard nobody has seen fire is indistinguishable from one that does not
 * exist. Peer review of this very task found that the START half had exactly
 * this kind of witness already, and the EXIT half did not - confirmed only by
 * a reviewer hand-building a harness, which is precisely the "a rule that
 * would stay green if it were deleted" shape three separate review rounds of
 * this repository have each found in a different place. Both halves get a
 * real witness here: each spawns the actual `scripts/mutation-check.mjs`,
 * not a reimplementation of its logic.
 *
 * The START witness's file carries this process's pid and a random suffix.
 * A fixed name would reproduce, inside this very test, the exact defect this
 * task exists to close: two overlapping runs of the whole suite (`node --test`
 * already runs test FILES in parallel; two people or two CI shards running at
 * once make it worse) would share one witness file, and one run's `finally`
 * could delete it out from under the other's spawned `mutation-check.mjs`
 * between that process's read of a dirty tree and its own conclusion - or
 * remove it before that process ever looked, making the tree look clean and
 * turning this into a false failure of the very thing it is meant to prove.
 * (This is not hypothetical: it is exactly what happened to this test the
 * first time it was written with a fixed filename, caught by stress-testing
 * with several concurrent full-suite runs.)
 *
 * Both tests also run under `withRealRootLock` (see real-root-lock.mjs):
 * without it, a DIFFERENT test file's own spawned `mutation-check.mjs` -
 * mutation-check-worktree-lifecycle.test.mjs's, specifically, since it also
 * depends on the real tree being clean when ITS spawn's start check runs -
 * can observe the witness file below mid-flight and take the wrong code
 * path, for a reason that has nothing to do with what either test is
 * actually proving. See that file's docstring for the full story; this was
 * also caught by stress-testing, not reasoned out in advance.
 *
 * The EXIT half cannot be witnessed the same way. By design, nothing in
 * `mutation-check.mjs` ever dirties the real tree - that is the entire
 * point of running against a worktree - so there is no external moment at
 * which a test process could inject dirt and reliably land inside the
 * narrow window between the script's own start check passing and its exit
 * check running, without racing the script's own timing (exactly the kind
 * of race this task exists to eliminate, not one to reintroduce in its own
 * tests). So `mutation-check.mjs` carries a small, explicitly-gated
 * TEST-ONLY seam instead (`MUTATION_CHECK_TEST_DIRTY_AT_EXIT`, read only
 * when this env var is set - never during a normal run): under that flag,
 * the script dirties its OWN real tree with one throwaway file immediately
 * before running its exit-time check, and removes it again right after
 * deciding the exit code. That makes the trigger deterministic rather than
 * timing-based, while still exercising the unmodified, real `realTreeStatus()`
 * call and override logic that a normal run uses. A second seam
 * (`MUTATION_CHECK_TEST_LIMIT`) truncates the mutation sweep so this does
 * not have to pay the full four-minute, 125-mutation run just to reach the
 * exit check - the exit check does not depend on how many mutations ran.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { withRealRootLock } from "./real-root-lock.mjs";
import { skipIfRealTreeIsDirty } from "./real-tree.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(ROOT, "scripts", "mutation-check.mjs");
const WITNESS = join(
  HERE,
  `.mutation-check-dirty-guard-witness.${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
);

/**
 * `check:mutations` spawns `node --test "tests/boundaries/*.test.mjs"` up to
 * over a hundred times (a baseline run per suite, plus one per mutation)
 * against its own worktree copy, and this file is part of that glob. Without
 * this guard, every one of those runs would ALSO dirty its copy (or set the
 * EXIT-only test seam) and spawn a nested `mutation-check.mjs`, which would
 * build a worktree copy of ITS OWN and start a nested sweep - unbounded
 * recursion, not merely slow.
 * The outer run sets this flag on every child process it spawns (see
 * `runSuite` in `mutation-check.mjs`); a run started under that flag already
 * knows the script starts clean and that its exit guard works, so both
 * tests below skip re-proving it.
 */
const skip =
  process.env.MUTATION_CHECK_RUNNING === "1"
    ? "avoids recursing into a nested mutation-check sweep while already inside one"
    : false;

test("mutation-check aborts before doing anything if the working tree is dirty", { skip }, (t) => {
  withRealRootLock(() => {
    // Round four finding I10: this test PROVES the guard by dirtying the
    // real tree itself, so it can still run on an already-dirty one - but
    // it would then assert against dirt it did not create, and its sibling
    // below could not run at all. Skipping both together keeps the pair
    // honest about what was and was not observed.
    if (skipIfRealTreeIsDirty(t)) return;
    writeFileSync(WITNESS, "witness file for the mutation-check dirty-tree guard test\n", "utf8");
    try {
      let result;
      try {
        const stdout = execFileSync(process.execPath, [SCRIPT], {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        result = { code: 0, out: stdout };
      } catch (error) {
        result = { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
      }
      assert.equal(
        result.code,
        2,
        `expected the dirty-tree guard to abort with exit code 2; got ${result.code}:\n${result.out}`,
      );
      assert.match(result.out, /working tree is not clean/i);
      const witnessName = WITNESS.replace(/\\/g, "/").split("/").pop();
      assert.ok(
        result.out.includes(witnessName),
        `expected the guard's own git-status output to name the file that dirtied ` +
          `the tree (${witnessName}):\n${result.out}`,
      );
    } finally {
      rmSync(WITNESS, { force: true });
    }
  });
});

test(
  "mutation-check fails the run if the working tree is dirty at exit, even though the sweep itself was clean",
  { skip },
  (t) => {
    withRealRootLock(() => {
      // Round four finding I10: on a dirty real tree the spawned script
      // aborts at its START check ("the working tree is not clean") and
      // never reaches the EXIT check this test exists to witness, so the
      // test failed under a name claiming the exit guard was broken. An
      // unmet precondition is a skip.
      if (skipIfRealTreeIsDirty(t)) return;
      const exitWitnessName = `.mutation-check-exit-guard-witness.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
      let result;
      try {
        const stdout = execFileSync(process.execPath, [SCRIPT], {
          cwd: ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            // Baseline suite only - the exit-time check runs regardless of how
            // many mutations were swept, so there is nothing to gain from
            // paying for all 63 in a test whose subject is the check that
            // runs AFTER the sweep, not the sweep itself.
            MUTATION_CHECK_TEST_LIMIT: "0",
            // Tells the script to dirty its OWN real tree with this one file,
            // deterministically, immediately before its exit-time check runs
            // (see the top-of-file comment for why this can't be done from
            // out here without racing the script's own timing).
            MUTATION_CHECK_TEST_DIRTY_AT_EXIT: exitWitnessName,
          },
        });
        result = { code: 0, out: stdout };
      } catch (error) {
        result = { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
      }
      // Defensive: the script removes its own witness file once it has decided
      // the exit code. This test's entire subject is "does that decision
      // actually happen," so it does not take that on faith for its own
      // cleanup - if the script left the file behind for any reason, this
      // still leaves the real tree exactly as clean as it found it.
      rmSync(join(ROOT, exitWitnessName), { force: true });

      assert.equal(
        result.code,
        2,
        `expected exit code 2 because the real tree was dirty when the exit ` +
          `check ran, even though the (limited) mutation sweep itself was ` +
          `clean; got ${result.code}:\n${result.out}`,
      );
      assert.match(
        result.out,
        /not clean at exit/i,
        `expected the EXIT-time half of the dirty-tree guard's own message; got:\n${result.out}`,
      );
      assert.match(
        result.out,
        /MUTATION_CHECK PASS|baseline GREEN/,
        `expected the (limited) sweep itself to have gone fine on its own terms - ` +
          `this test is about the exit guard overriding an otherwise-clean result, ` +
          `not about a sweep failure; got:\n${result.out}`,
      );
    });
  },
);
