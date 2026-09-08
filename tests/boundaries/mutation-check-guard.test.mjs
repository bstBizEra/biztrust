/**
 * The dirty-tree guard on `scripts/mutation-check.mjs`.
 *
 * `mutation-check.mjs` used to mutate the tracked `scripts/boundary-rules.mjs`
 * and `scripts/migration-lint.mjs` in place, restoring in a `finally`. An
 * interrupted run left a loosened rule sitting in a tracked source file. It
 * now runs entirely against a disposable `git worktree` copy of HEAD instead
 * (see the top of that script), and refuses to start at all if the real
 * working tree is not clean - there would be nothing safe to check out.
 *
 * A guard nobody has seen fire is indistinguishable from one that does not
 * exist: this test dirties the tree with one throwaway untracked file, runs
 * the real script, and asserts it aborts with exit code 2 before doing
 * anything else (no worktree, no mutation sweep - both would be visible as a
 * much slower run). The witness file is removed in a `finally`, so this test
 * itself never leaves the tree dirty.
 *
 * The witness filename carries this process's pid and a random suffix. A
 * fixed name would reproduce, inside this very test, the exact defect this
 * task exists to close: two overlapping runs of the whole suite (`node --test`
 * already runs test FILES in parallel; two people or two CI shards running at
 * once make it worse) would share one witness file, and one run's `finally`
 * could delete it out from under the other's spawned `mutation-check.mjs`
 * between that process's read of a dirty tree and its own conclusion - or
 * remove it before that process ever looked, making the tree look clean and
 * turning this into a false failure of the very thing it is meant to prove.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(ROOT, "scripts", "mutation-check.mjs");
const WITNESS = join(
  HERE,
  `.mutation-check-dirty-guard-witness.${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
);

/**
 * `check:mutations` spawns `node --test "tests/boundaries/*.test.mjs"` up to
 * 64 times (a baseline run plus one per mutation) against its own worktree
 * copy, and this file is part of that glob. Without this guard, every one of
 * those runs would ALSO dirty its copy and spawn a nested
 * `mutation-check.mjs`, which would build a worktree copy of ITS OWN and
 * start a nested sweep - unbounded recursion, not merely slow. The outer run
 * sets this flag on every child process it spawns (see `runSuite` in
 * `mutation-check.mjs`); a run started under that flag already knows the
 * script starts clean, so it skips re-proving it.
 */
const skip =
  process.env.MUTATION_CHECK_RUNNING === "1"
    ? "avoids recursing into a nested mutation-check sweep while already inside one"
    : false;

test("mutation-check aborts before doing anything if the working tree is dirty", { skip }, () => {
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
