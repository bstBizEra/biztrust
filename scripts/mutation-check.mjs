#!/usr/bin/env node
/**
 * The instrument that tests the instruments.
 *
 *   node scripts/mutation-check.mjs
 *
 * A test suite that passes whether or not the rule works is worth nothing, and
 * a green suite cannot tell you which of the two it is. This script loosens one
 * rule at a time, runs the boundary and migration suites, and requires the
 * suite to go RED. A mutation that SURVIVES names a rule that is not actually
 * enforced by any fixture.
 *
 * It exists because a peer review of `BIZTRUST-WP-001` did exactly this by
 * hand and found four loosenings the suite did not notice: rule 5 widened to
 * any `src/public/` file, rule 5 narrowed to internals only, rule 6 narrowed to
 * services, and rule 5b narrowed to modules. Every one of those would have
 * shipped a boundary that looked tested and was not. Running it by hand once
 * finds today's gaps; running it in CI keeps them found.
 *
 * Two mutations that SURVIVED on the second pass were not rule bugs but test
 * bugs: a fixture carrying two violations of the same rule proves neither,
 * because disabling one leaves the file still reported. The migration controls
 * now assert on the message, not just the rule name.
 *
 * Every mutation used to be written into the tracked `scripts/boundary-rules.mjs`
 * and `scripts/migration-lint.mjs`, restored in a `finally`. That is not safe:
 * an interrupted run (Ctrl-C, a crash, a killed CI job) leaves a LOOSENED RULE
 * sitting in a tracked source file, and `pnpm boundaries:check` then reports
 * PASS or FAIL against whichever mutation happened to be live when it was
 * interrupted - not against the code anyone reviewed. This script now mutates
 * and tests a disposable `git worktree` checkout of HEAD instead (see
 * `createWorktree`/`destroyWorktree` below); the real tracked files are never
 * opened for writing. `node_modules` is linked into the worktree with a
 * Windows junction (no elevated privileges required) rather than copied, since
 * it is large, never mutated, and read-only for every mutation run.
 *
 * A dirty-tree guard backs this up at both ends: the run aborts before doing
 * anything if `git status --porcelain` is already non-empty (there is nothing
 * safe to check out and compare against), and it fails even a fully-caught run
 * if the real tree is dirty at exit. A PASS must mean the tracked source was
 * never touched, not merely that it was touched and successfully restored.
 * (tests/boundaries/mutation-check-guard.test.mjs witnesses both halves by
 * spawning this script for real.)
 *
 * Restores every worktree file it touches, on success, on failure and on
 * throw, and always removes the worktree itself before exiting.
 *
 * The worktree's own lifecycle has two more safeguards, added after peer
 * review found this script's OWN cleanup was not safe against the exact kind
 * of interruption its dirty-tree guard exists to tolerate:
 *
 *   - Creation is atomic. `git worktree add` can succeed and a later step
 *     (writing the owner file, linking node_modules) can still fail;
 *     `createWorktree` tears down whatever it already built before
 *     propagating, rather than leaking a half-built checkout.
 *   - A killed run (Ctrl-C, `kill -9`, a torn-down CI job) skips every
 *     `finally` in this process, so `destroyWorktree` never runs and the
 *     worktree is orphaned - on disk and in `git worktree list` - forever,
 *     since `git worktree prune` alone does not remove a worktree whose
 *     directory still exists. `reclaimOrphanWorktrees` runs at the start of
 *     every invocation and removes any worktree under this script's own
 *     `WORKTREE_PREFIX` whose recorded owner pid is no longer running,
 *     self-healing the next run rather than leaking one more checkout per
 *     interruption. (tests/boundaries/mutation-check-worktree-lifecycle.test.mjs
 *     witnesses both of these by spawning this script for real, using
 *     TEST-ONLY env-var seams to land deterministically in the exact
 *     failure windows a reviewer found by hand.)
 *
 * Round five: it is not enough that the suite went RED. A mutation recorded
 * `caught` because SOMETHING failed is exactly as weak, one level up, as the
 * green suite this script exists to catch: the control that is supposed to
 * prove that rule may have stayed green while a sibling reported the file for
 * an unrelated reason. Every mutation therefore names the control that should
 * catch it, both suites are read per-test rather than by exit code (TAP for
 * the boundary suite, `unittest -v` for the validator's - see
 * `scripts/mutation-attribution.mjs`), and a mutation caught by anything
 * other than its own declared witness FAILS the run. The first honest run of
 * this found two: a rule-5 mutation that had been rewriting rule 2's line for
 * four review rounds, and a CREATE/DROP SCHEMA mutation whose control matched
 * an echoed clause the deny-by-default path echoes too.
 *
 * The run also reports both directions of the overlap - mutations killed by
 * more than one control, controls killing more than one mutation - because
 * neither is automatically a defect and neither is visible from a pass line.
 *
 * Exit codes: 0 every mutation caught by its declared witness; 1 at least one
 * survived, lost or duplicated its anchor, declared no witness or the wrong
 * one, or was caught only by a control another mutation already claims; 2 the
 * baseline suite was not green or named no test, the working tree was not
 * clean at start, the working tree was not clean at exit, or the worktree
 * itself could not be created - any of which means this run proves nothing.
 */

import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT as REAL_ROOT } from "./registry.mjs";
import {
  readTap,
  readUnittest,
  witnessesOf,
  witnessedBy,
  reasonOf,
  rosterDefect,
  anchorDefect,
  declarationDefects,
  indistinguishable,
  overlaps,
  verdict,
} from "./mutation-attribution.mjs";

/**
 * Whether to print the overlap LISTING as well as its counts.
 *
 * An argument rather than an environment variable, for the reason round four
 * residual 1 made the coverage gate's own seam one: `runSuite` forwards the
 * ambient environment into every suite this sweep spawns, so a variable read
 * here would also be read by everything below it.
 */
const LIST_OVERLAP = process.argv.slice(2).includes("--overlap");

// Every worktree this script ever creates lives under this exact prefix (see
// `createWorktree`). That is what makes an orphan from a killed run
// recognisable to a later run: `reclaimOrphanWorktrees` below looks at
// `git worktree list` for entries under this prefix rather than needing its
// own separate bookkeeping file.
//
// TEST-ONLY: MUTATION_CHECK_TEST_WORKTREE_TAG, when set, appends a tag to
// the prefix instead of using the fixed default. Read only by
// tests/boundaries/mutation-check-worktree-lifecycle.test.mjs's finding-2
// case, which deliberately leaves a real orphan behind to prove reclamation
// - and `node --test` runs test FILES in parallel, so a sibling test file's
// own, concurrently-spawned mutation-check.mjs (the exit-guard witness,
// say) would otherwise see that orphan under the SAME default prefix and
// legitimately reclaim it first, out from under the test that planted it.
// Each test run generates its own random tag and threads it through every
// child it spawns, so only that test's own invocations ever see its own
// worktree - exactly the "give it a unique namespace" fix this task already
// applied once, to the dirty-tree guard witness's filename, for the same
// reason. A normal invocation never sets this, so production behaviour is
// unchanged.
const WORKTREE_PREFIX = join(
  tmpdir(),
  process.env.MUTATION_CHECK_TEST_WORKTREE_TAG
    ? `biztrust-mutation-test-${process.env.MUTATION_CHECK_TEST_WORKTREE_TAG}-`
    : "biztrust-mutation-",
);

/** The file a worktree's owner writes inside it, naming the pid that created
 * it. `reclaimOrphanWorktrees` uses this to tell "an earlier run died and
 * left this behind" apart from "a sibling run is using this right now" -
 * without it, two invocations running at once (two developers, two CI
 * shards on the same box) could destroy each other's live worktree. */
const OWNER_FILE = ".mutation-check-owner-pid";

/** `git status --porcelain` against the REAL repository, not any worktree. */
function realTreeStatus() {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: REAL_ROOT,
    encoding: "utf8",
  });
}

const dirtyAtStart = realTreeStatus();
if (dirtyAtStart.trim() !== "") {
  process.stderr.write(
    "MUTATION_CHECK FAIL the working tree is not clean, so there is nothing " +
      "safe to check out and mutate a copy of. Commit or stash first:\n" +
      dirtyAtStart,
  );
  process.exit(2);
}

/** Removes a directory symlink/junction WITHOUT following it into its
 * target. `rmdirSync` is the Windows-correct call for a directory reparse
 * point; the fallbacks cover the rare platform where that is not how the
 * link was created. */
function removeDirLink(path) {
  try {
    rmdirSync(path);
    return;
  } catch {
    // fall through
  }
  try {
    unlinkSync(path);
    return;
  } catch {
    // fall through
  }
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort; destroyWorktree still removes the whole worktree next
  }
}

/** `git worktree list --porcelain` parsed down to the list of worktree
 * paths, main worktree included. Empty on any git failure - a listing
 * failure must never look like "no worktrees to reclaim." */
function listWorktreePaths() {
  let out;
  try {
    out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: REAL_ROOT,
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  return out
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** Whether process `pid` is still running. Conservative on an inconclusive
 * result (EPERM: it exists but this process cannot signal it - still
 * alive): reclaiming is only safe to skip too often, never to over-trigger. */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Finds worktrees left behind by an earlier invocation of this script that
 * did not get to clean up after itself - typically a killed process (Ctrl-C,
 * `kill -9`, an aborted CI job): `finally` blocks do not run, so
 * `destroyWorktree` is never reached, and `git worktree prune` alone does
 * NOT remove a worktree whose directory still exists on disk, only the
 * admin bookkeeping for ones whose directory is already gone. Left
 * unreclaimed, every interrupted run during this script's multi-minute
 * window leaks another full checkout on disk and in `git worktree list`,
 * forever, with nothing telling the operator.
 *
 * Only ever touches a worktree (a) under this script's own, fixed
 * `WORKTREE_PREFIX` - never the main worktree or anything unrelated - and
 * (b) whose recorded owner pid (see `OWNER_FILE`) is no longer running, so a
 * genuinely live sibling invocation (two developers, two CI shards) is left
 * alone rather than destroyed out from under itself. A worktree under the
 * prefix with no readable owner file is treated as reclaimable: that shape
 * only happens if a run died between `git worktree add` succeeding and the
 * owner file being written, a narrower window than the one this exists to
 * close.
 */
function reclaimOrphanWorktrees() {
  const prefix = WORKTREE_PREFIX.replace(/\\/g, "/");
  for (const path of listWorktreePaths()) {
    // The main worktree is excluded by the prefix test below and by that
    // alone. A `path === REAL_ROOT` comparison stood here as a second,
    // reassuring guard and PROVABLY never matched on Windows: git reports
    // forward slashes, `REAL_ROOT` carries the platform separator, so the
    // two strings are never equal even when they name the same directory.
    // A guard that cannot fire is worse than no guard, because the next
    // reader trusts it and stops checking whether the real one is right.
    // Removed rather than repaired: the prefix test excludes the main
    // worktree independently, on both platforms, and normalises the
    // separators it compares.
    if (!path.replace(/\\/g, "/").startsWith(prefix)) continue;

    let ownerPid = null;
    try {
      ownerPid = Number(readFileSync(join(path, OWNER_FILE), "utf8").trim());
    } catch {
      // no owner file: reclaimable (see docstring above)
    }
    if (Number.isInteger(ownerPid) && ownerPid > 0 && isProcessAlive(ownerPid)) {
      continue;
    }

    process.stderr.write(
      `MUTATION_CHECK reclaiming an orphaned worktree from an earlier, interrupted run: ${path}\n`,
    );
    destroyWorktree(path);
  }
}

/** Checks out a disposable copy of HEAD in a temp directory and links (not
 * copies) `node_modules` into it, so the boundary suite can run there with no
 * write ever reaching the real repository. Returns the worktree's root.
 *
 * Not atomic by default - `git worktree add` can succeed and a later step
 * (writing the owner file, linking node_modules) can still fail - so every
 * step after `add` is wrapped: on any failure, whatever was created is torn
 * down with `destroyWorktree` before the error propagates. Without this, a
 * failure in exactly that window leaks a full checkout with no cleanup
 * attempt at all, the same shape `reclaimOrphanWorktrees` exists to clean up
 * LATER, but avoidable immediately, in the same run that caused it. */
function createWorktree() {
  reclaimOrphanWorktrees();
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: REAL_ROOT, stdio: "ignore" });
  } catch {
    // a stale admin entry is not fatal; `worktree add` below will still work
  }
  const dir = mkdtempSync(WORKTREE_PREFIX);
  let added = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], {
      cwd: REAL_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
    added = true;

    // TEST-ONLY seam, read by tests/boundaries/mutation-check-worktree-lifecycle.test.mjs.
    // Reproduces the exact reviewer-forced failure for finding 1: `git
    // worktree add` has already succeeded when this throws, so the `catch`
    // below is the only thing standing between that and a leaked checkout.
    if (process.env.MUTATION_CHECK_TEST_FAIL_AFTER_ADD) {
      throw new Error("MUTATION_CHECK_TEST_FAIL_AFTER_ADD: simulated failure after `git worktree add`");
    }

    writeFileSync(join(dir, OWNER_FILE), String(process.pid), "utf8");
    symlinkSync(
      join(REAL_ROOT, "node_modules"),
      join(dir, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    // TEST-ONLY seam, same file. Simulates a killed run: a real `kill -9`
    // (or Ctrl-C, or a CI job getting torn down) skips every `finally` in
    // this process, which `throw` does not - so this exits the process
    // outright, immediately after a fully-formed worktree (owner file and
    // node_modules link both written) exists on disk and in `git worktree
    // list`, exactly as a real kill mid-sweep would leave one behind. The
    // point under test is not this line; it's whether the NEXT invocation's
    // `reclaimOrphanWorktrees` finds and removes what this one leaves.
    if (process.env.MUTATION_CHECK_TEST_KILL_AFTER_ADD) {
      process.stderr.write(`MUTATION_CHECK_TEST_KILL_AFTER_ADD: exiting without cleanup, worktree left at ${dir}\n`);
      process.exit(137);
    }

    return dir;
  } catch (error) {
    if (added) {
      destroyWorktree(dir);
    } else {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort; nothing was ever registered with git for this one
      }
    }
    throw error;
  }
}

/** Removes the node_modules link and the worktree, and prunes git's
 * bookkeeping for it. Never touches the real repository's own files. */
function destroyWorktree(dir) {
  removeDirLink(join(dir, "node_modules"));
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], {
      cwd: REAL_ROOT,
      stdio: "ignore",
    });
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // leaves a stray temp directory at worst; not a correctness issue
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: REAL_ROOT, stdio: "ignore" });
    } catch {
      // best-effort
    }
  }
}

let WT_ROOT;
try {
  WT_ROOT = createWorktree();
} catch (error) {
  process.stderr.write(
    `MUTATION_CHECK FAIL could not create an isolated worktree: ${error?.stack ?? error}\n`,
  );
  process.exit(2);
}
const RULES = join(WT_ROOT, "scripts", "boundary-rules.mjs");
const LINT = join(WT_ROOT, "scripts", "migration-lint.mjs");
const GATE = join(WT_ROOT, "scripts", "coverage-gate.mjs");
const CODEOWNERS = join(WT_ROOT, "scripts", "generate-codeowners.mjs");
const RECORDS = join(WT_ROOT, "scripts", "validate_continuity.py");
const ATTRIBUTION = join(WT_ROOT, "scripts", "mutation-attribution.mjs");
const SIGNING_POLICY = join(WT_ROOT, "scripts", "signing-policy.mjs");
const GENERATOR = join(WT_ROOT, "scripts", "generate-boundary-rules.mjs");
const MODULE_CHECK = join(WT_ROOT, "scripts", "check-module-packages.mjs");
const CI_WORKFLOW = join(WT_ROOT, ".github", "workflows", "ci.yml");
const WORKSPACE = join(WT_ROOT, "pnpm-workspace.yaml");
const LOCKFILE = join(WT_ROOT, "pnpm-lock.yaml");
const TENANCY_PACKAGE = join(WT_ROOT, "modules", "tenancy", "package.json");
const SIGNING_CHECK = join(WT_ROOT, "scripts", "check-signing.mjs");
// Not a script. The ORDER of the verify chain is a control - the JS signing
// policy reader is fail-closed only because validate:records runs before
// check:signing - and a control that lives in data rather than in code is
// still a control, so it is mutated like one.
const PACKAGE = join(WT_ROOT, "package.json");
// Also data, and also a control: the compiler option that makes an unresolvable
// side-effect import an error is the second layer under the boundary check.
const TSCONFIG_BASE = join(WT_ROOT, "tsconfig.base.json");

/** Joins anchor lines, so no source string carries an embedded newline. */
const lines = (...parts) => parts.join("\n");

// A backtick and a dollar, spelled out. An anchor that quotes a template
// literal from the source cannot itself be a template literal: String.raw
// still interpolates ${...}, so the anchor would evaluate rather than match.
const BT = String.fromCharCode(96);
const DOLLAR = String.fromCharCode(36);
// A backslash, spelled out, for the same reason: an anchor that quotes a regular
// expression source needs backslashes, and an escape inside an escape is where
// these anchors have been corrupted before.
const BACKSLASH = String.fromCharCode(92);

const MUTATIONS = [
  // ---- found by the WP-001 independent review, issue #8 ------------------
  {
    file: GENERATOR,
    name: "generator: stop comparing the generated files (A2)",
    witness: "--check fails on a hand-edited .dependency-cruiser.cjs, naming it stale",
    from: "    if (found !== wanted) {",
    to: "    if (false && found !== wanted) {",
  },
  {
    file: GENERATOR,
    // Round seven, controls N3. The three tests the mutation above is killed
    // by all pass --out-dir, so a conditional that read that seam left them
    // green while the check CI runs (no --out-dir) compared nothing.
    name: "generator: compare the generated files only when --out-dir is given (N3)",
    witness: "--check with no --out-dir compares the files at the repository root",
    from: "    const stale = staleOutputs(outputs);",
    to: "    const stale = outDir ? staleOutputs(outputs) : [];",
  },
  {
    file: RULES,
    name: "rule 1 by package name: stop matching unresolved internal imports (A1)",
    witness:
      "control 1: a module reaches into another's internals by package name is reported as " +
      "rule-1-internals-private-by-name-alpha",
    from: "      to: { couldNotResolve: true, path: internalByName(m.name) },",
    to: "      to: { couldNotResolve: false, path: internalByName(m.name) },",
  },
  {
    file: RULES,
    // Round seven, controls N1. The rule used to match only the literal prefix
    // @biztrust/<m>/src/internal/. Narrowing it back to that prefix leaves the
    // three specifiers below unreported by anything.
    name: "rule 1 by package name: match only the literal src/internal/ prefix (N1)",
    witness:
      "control 1: the same, spelled with a .. segment (src/public/../internal/) is reported as " +
      "rule-1-internals-private-by-name-alpha",
    from: "      to: { couldNotResolve: true, path: internalByName(m.name) },",
    to: "      to: { couldNotResolve: true, path: " + BT + "^@biztrust/" + DOLLAR + "{rx(m.name)}/src/internal/" + BT + " },",
  },
  {
    file: RULES,
    name: "rule 2 by package name: stop matching unresolved deep imports (A1)",
    witness:
      "control 2: a module imports another by a deep package path, not its contract is reported as " +
      "rule-2-contracts-only-by-name-beta",
    from: "        couldNotResolve: true,",
    to: "        couldNotResolve: false,",
  },
  {
    file: RULES,
    name: "rule 5 by package name: stop matching unresolved deep imports (A1)",
    witness:
      "control 5: an entry point reaches past a contract by package name is reported as " +
      "rule-5-entry-points-see-contracts-only-by-name",
    from: '    to: { couldNotResolve: true, path: SCOPE + anyModule + SEP + ".+" },',
    to: '    to: { couldNotResolve: false, path: SCOPE + anyModule + SEP + ".+" },',
  },
  // ---- the dependency rules ----------------------------------------------
  {
    file: RULES,
    name: "rule 1: protect no module's internals",
    witness:
      "control 1: a module reaches into the internals of another is reported as " +
      "rule-1-internals-private-alpha",
    from: '      from: { pathNot: ' + BT + '^modules/' + DOLLAR + '{rx(m.name)}/' + BT + ' },',
    to: '      from: { pathNot: "^modules/" },',
  },
  {
    file: RULES,
    name: "rule 2: allow a cross-module import of any public file",
    witness:
      "control 2: a cross-module import that is not the contract is reported as " +
      "rule-2-contracts-only-beta",
    from: '        pathNot: "^modules/[^/]+/src/public/index\\\\.ts$",',
    to: '        pathNot: "^modules/[^/]+/src/public/",',
  },
  {
    file: RULES,
    name: "rule 3: stop forbidding cycles",
    witness: "control 3: a cycle between two modules is reported as rule-3-no-cycles",
    from: '    to: { circular: true },',
    to: '    to: { circular: false },',
  },
  {
    file: RULES,
    name: "rule 4: only the package named shared may not import a module",
    witness:
      "control 4: a second, differently named package reaches for domain code is reported as " +
      "rule-4-packages-import-no-module",
    from: '    from: { path: "^packages/" },',
    to: '    from: { path: "^packages/shared/" },',
  },
  {
    file: RULES,
    name: "rule 5: allow an entry point to import any public file, not the contract",
    witness:
      "control 5: an entry point imports a module's public file that is not the contract is " +
      "reported as rule-5-entry-points-see-contracts-only",
    // The `pathNot` line alone is a SUFFIX of rule 2's identical, more deeply
    // indented line, and rule 2 is generated above rule 5 - so this mutation
    // rewrote rule 2 for four review rounds, was duly caught by rule 2's
    // control, and reported that rule 5 was covered. Rule 5's own `to.path` is
    // what tells the two apart, so the anchor is both lines. (The attribution
    // this task added found it; `anchorDefect` now refuses an anchor that
    // matches twice, so it cannot come back silently.)
    from: lines(
      '      path: "^modules/[^/]+/(?:src|dist)/",',
      '      pathNot: "^modules/[^/]+/src/public/index\\\\.ts$",',
    ),
    to: lines(
      '      path: "^modules/[^/]+/(?:src|dist)/",',
      '      pathNot: "^modules/[^/]+/src/public/",',
    ),
  },
  {
    file: RULES,
    name: "rule 5b: only a module may not import an entry point",
    witness:
      "control 6: a package imports an entry point is reported as " +
      "rule-5-nothing-imports-an-entry-point",
    from: '    from: { pathNot: "^(services|apps)/" },',
    to: '    from: { path: "^modules/" },',
  },
  {
    file: RULES,
    name: "rule 5: narrow entry points to services only, dropping apps",
    witness:
      "control 5: an app that is not the control plane bypasses a contract is reported as " +
      "rule-5-entry-points-see-contracts-only",
    from: '    from: { path: "^(services|apps)/" },',
    to: '    from: { path: "^services/" },',
  },
  {
    file: RULES,
    name: "rule 5b: narrow the entry-point target to services only, dropping apps",
    witness:
      "control 6: a module imports an app, not a service is reported as " +
      "rule-5-nothing-imports-an-entry-point",
    from: '    to: { path: "^(services|apps)/" },',
    to: '    to: { path: "^services/" },',
  },
  {
    file: RULES,
    name: "rule 6: only a service may not import a test package",
    witness:
      "control 7: a module reaches the test-only bypass package is reported as " +
      "rule-6-test-packages-stay-in-tests",
    from: '    from: { pathNot: "^tests/" },',
    to: '    from: { path: "^services/" },',
  },
  {
    file: RULES,
    name: "rule 7: let the control plane call a module contract",
    witness:
      "control 8: the control plane calls a module contract in-process is reported as " +
      "rule-7-control-plane-sees-packages-only",
    from: '    from: { path: "^apps/control-plane/" },',
    to: '    from: { path: "^apps/nothing-matches-this/" },',
  },

  // ---- the migration lint -------------------------------------------------
  {
    file: LINT,
    name: "scrub: stop unquoting double-quoted identifiers",
    witness: "control 4: a double-quoted schema name writes outside its schema is reported as M1",
    from: "      out.push(inner.toLowerCase());",
    to: "      out.push('\"' + inner + '\"');",
  },
  {
    file: LINT,
    // The rewrite below falls through to the `else if (target.schema !== schema)`
    // branch, which still reports M1 - with `touches schema "null"`. So this
    // mutation is caught by the control's MESSAGE assertion, not by the rule
    // continuing to fire. Round three found the old name claiming the opposite.
    name: "M1: report an unqualified name as a schema mismatch instead (message only)",
    witness: "baseline: an object name with no schema qualifier is reported as M1",
    from: '      if (target.schema === null) {',
    to: '      if (false) {',
  },
  {
    file: LINT,
    name: "M1: stop refusing search_path",
    witness: "baseline: a migration that sets search_path is reported as M1",
    from: '    if (/\\bSET\\s+(?:LOCAL\\s+|SESSION\\s+)?search_path\\b/i.test(statement)) {',
    to: '    if (false) {',
  },
  {
    file: LINT,
    name: "M1: stop denying by default on an unmodelled statement",
    witness: "control 4: eight DDL verbs the lint did not model is reported as M1",
    from:
      '  return { targets, understood: targets.some((t) => t.resolvesStatement) };',
    to: '  return { targets, understood: true };',
  },
  {
    file: LINT,
    // Round three, checkpoint declared_non_coverage item 7: the old refusal
    // fired only when a statement OPENED with CREATE, ALTER or DROP, so COPY,
    // MERGE and every other verb outside that allow-list linted clean no
    // matter what schema they touched. Reverting to that allow-list must turn
    // the suite red by itself, independent of whether any target scan below
    // still runs.
    name: "M1: revert the deny-list to the old CREATE/ALTER/DROP opening-verb allow-list",
    witness:
      "control R3-14: a statement opening with a verb this lint does not model at all is " +
      "reported as M1",
    from:
      '  return { targets, understood: targets.some((t) => t.resolvesStatement) };',
    to: '  const isDDL = /^\\s*(?:CREATE|ALTER|DROP)\\b/i.test(statement);\n  return { targets, understood: !isDDL || targets.length > 0 };',
  },
  {
    file: LINT,
    name: "M1: stop modelling COPY as a target of the schema it writes into",
    witness: "control R3-12: COPY writes rows into another module's schema is reported as M1",
    from: '  scan(new RegExp(String.raw`\\bCOPY\\s+(${ID})(?:\\.(${ID}))?`, "gi"), (m) => {\n    if (m[2] === undefined) pushResolved(null, m[1], m[0], "COPY");\n    else pushResolved(m[1], m[2], m[0], "COPY");\n  });',
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling MERGE INTO as a target of the schema it writes into",
    witness: "control R3-13: MERGE INTO writes rows into another module's schema is reported as M1",
    from: '  scan(new RegExp(String.raw`\\bMERGE\\s+INTO\\s+(${ID})(?:\\.(${ID}))?`, "gi"), (m) => {\n    if (m[2] === undefined) pushResolved(null, m[1], m[0], "MERGE INTO");\n    else pushResolved(m[1], m[2], m[0], "MERGE INTO");\n  });',
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling REFRESH MATERIALIZED VIEW as a target of the schema it refreshes",
    witness:
      "control R3-15: REFRESH MATERIALIZED VIEW refreshes an object in another module's schema " +
      "is reported as M1",
    from: "  scan(\n    new RegExp(\n      String.raw`\\bREFRESH\\s+MATERIALIZED\\s+VIEW\\s+(?:CONCURRENTLY\\s+)?(${ID})(?:\\.(${ID}))?`,\n      \"gi\",\n    ),\n    (m) => {\n      if (m[2] === undefined) pushResolved(null, m[1], m[0], \"REFRESH MATERIALIZED VIEW\");\n      else pushResolved(m[1], m[2], m[0], \"REFRESH MATERIALIZED VIEW\");\n    },\n  );",
    to: '  void 0;',
  },
  {
    file: LINT,
    // Review finding, CRITICAL: LOCK, ANALYZE and VACUUM each accept a
    // comma-separated table list, and the fixed code walks it with
    // pushCommaSeparatedTargets. This mutation reintroduces the exact
    // regression a text review caught: reading only the FIRST item of the
    // list and silently ignoring the rest, which is how a cross-schema table
    // listed after a same-schema one used to lint clean.
    name: "M1: LOCK reads only the first name in a comma-separated table list again",
    witness:
      "control R3-16: a table later in a LOCK list is in another module's schema is reported as " +
      "M1",
    from: '      pushCommaSeparatedTargets(rest, "LOCK", pushResolved);',
    to: '      pushCommaSeparatedTargets(rest.split(",")[0], "LOCK", pushResolved);',
  },
  {
    file: LINT,
    name: "M1: ANALYZE reads only the first name in a comma-separated table list again",
    witness:
      "control R3-17: a table later in an ANALYZE list is in another module's schema is " +
      "reported as M1",
    from: '      pushCommaSeparatedTargets(m[1], "ANALYZE", pushResolved);',
    to: '      pushCommaSeparatedTargets(m[1].split(",")[0], "ANALYZE", pushResolved);',
  },
  {
    file: LINT,
    name: "M1: VACUUM reads only the first name in a comma-separated table list again",
    witness:
      "control R3-18: a table later in a VACUUM list is in another module's schema is reported " +
      "as M1",
    from: '      pushCommaSeparatedTargets(m[1], "VACUUM", pushResolved);',
    to: '      pushCommaSeparatedTargets(m[1].split(",")[0], "VACUUM", pushResolved);',
  },
  {
    file: LINT,
    name: "M1: stop modelling REINDEX as a target of the schema it touches",
    witness: "control R3-19: REINDEX touches an object in another module's schema is reported as M1",
    from: "  scan(\n    new RegExp(\n      String.raw`\\bREINDEX\\s+(?:\\([^)]*\\)\\s+)?(?:INDEX|TABLE|SCHEMA|DATABASE|SYSTEM)\\s+(?:CONCURRENTLY\\s+)?(${ID})(?:\\.(${ID}))?`,\n      \"gi\",\n    ),\n    (m) => {\n      if (m[2] === undefined) pushResolved(null, m[1], m[0], \"REINDEX\");\n      else pushResolved(m[1], m[2], m[0], \"REINDEX\");\n    },\n  );",
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling CLUSTER as a target of the schema it touches",
    witness: "control R3-20: CLUSTER touches an object in another module's schema is reported as M1",
    from: '  scan(new RegExp(String.raw`\\bCLUSTER\\s+(?:VERBOSE\\s+)?(${ID})(?:\\.(${ID}))?`, "gi"), (m) => {\n    if (m[2] === undefined) pushResolved(null, m[1], m[0], "CLUSTER");\n    else pushResolved(m[1], m[2], m[0], "CLUSTER");\n  });',
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling SELECT ... INTO as a target of the schema it creates a table in",
    witness:
      "control R3-21: SELECT ... INTO creates a table in another module's schema is reported as " +
      "M1",
    from: '      if (m[2] === undefined) pushResolved(null, m[1], m[0], "SELECT INTO", "table");\n      else pushResolved(m[1], m[2], m[0], "SELECT INTO", "table");',
    to: '      void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling CREATE SCHEMA and DROP SCHEMA",
    witness: "control 4: DROP SCHEMA against another module is reported as M1",
    from: '    (m) => pushResolved(m[2], null, m[0], ' + BT + DOLLAR + '{m[1].toUpperCase()} SCHEMA' + BT + '),',
    to: '    () => {},',
  },
  {
    file: LINT,
    name: "M1: stop modelling ALTER ... SET SCHEMA",
    witness: "control 4: moving an object into another schema with SET SCHEMA is reported as M1",
    from: '    (m) => pushResolved(m[1], null, m[0], "SET SCHEMA"),',
    to: '    () => {},',
  },
  {
    file: LINT,
    name: "M2: drop the unqualified-REFERENCES half",
    witness: "baseline: an unqualified REFERENCES is reported as M2",
    from: '  for (const m of statement.matchAll(unqualified)) {',
    to: '  for (const m of []) {',
  },
  {
    file: LINT,
    name: "M3: stop refusing DELETE and DROP on the audit schema",
    witness: [
      "control 12: a mutation of an audit table is reported as M3",
      "control R3-9: DROP on the audit schema is reported as M3",
    ],
    from: 'const AUDIT_FORBIDDEN = ["UPDATE", "DELETE", "TRUNCATE", "DROP"];',
    to: 'const AUDIT_FORBIDDEN = ["UPDATE", "TRUNCATE"];',
  },
  {
    file: LINT,
    name: "M3: stop refusing an audit column drop (its own sub-check)",
    witness: "control 12: a column drop on the audit schema is reported as M3",
    from: '        report("M3", "a column drop is refused on the audit schema");',
    to: '        void 0;',
  },
  {
    file: LINT,
    name: "M3: stop refusing an audit column type change (its own sub-check)",
    witness: "control 12: a column type change on the audit schema is reported as M3",
    from: '        report("M3", "a column type change is refused on the audit schema");',
    to: '        void 0;',
  },
  {
    file: LINT,
    name: "M4: anchor the stems so a prefix like policyholder escapes",
    witness: "control 11: a domain word as a prefix of a longer name is reported as M4",
    from: '  { label: "policy", pattern: /^polic(y|ies)/i },',
    to: '  { label: "policy", pattern: /^polic(y|ies)$/i },',
  },
  {
    file: LINT,
    name: "M4: revert to a matcher blind to the plural",
    witness: "control 11: the plural of a second domain word is reported as M4",
    from: '  { label: "claim", pattern: /^claim/i },',
    to: '  { label: "claim", pattern: /^claim$/i },',
  },

  // ---- round three open finding 8: M4/M5 gated on one verb -----------------
  {
    file: LINT,
    // Both M4 and M5 filter their targets through TABLE_CREATING_VERBS, so
    // dropping CREATE FOREIGN TABLE from the set turns both rules blind to a
    // foreign table at once; the R3-22 fixture (M4 on CREATE FOREIGN TABLE)
    // and R3-27 (M4 on ALTER FOREIGN TABLE ... RENAME TO, which is gated by
    // the same set membership check) both catch it.
    name: "M4/M5: drop CREATE FOREIGN TABLE from the table-creating verb set",
    witness: "control R3-22: CREATE FOREIGN TABLE creates a P0 domain table is reported as M4",
    from: '  "CREATE FOREIGN TABLE",\n',
    to: "",
  },
  {
    file: LINT,
    // Same set, the other CREATE-side entry from this task's first pass.
    // Caught by R3-24 (M4 on CREATE VIEW named for a domain word), R3-25 (M5
    // on a view with no tenant_id, the open-question decision this task
    // made), R3-26 (M4 on ALTER VIEW ... RENAME TO) and R3-28 (M4 on ALTER
    // MATERIALIZED VIEW ... RENAME TO, which folds to the same "VIEW" verb).
    name: "M4/M5: drop CREATE VIEW from the table-creating verb set",
    witness: [
      "control R3-24: CREATE VIEW creates a P0 domain-named relation is reported as M4",
      "control R3-25: a view with no tenant_id is reported as M5",
    ],
    from: '  "CREATE VIEW",\n',
    to: "",
  },
  {
    file: LINT,
    // Added by ruling on review of this task, not the original brief: SELECT
    // ... INTO creates a table exactly as CREATE TABLE does. Caught by R3-29
    // (M4) and R3-30 (M5).
    name: "M4/M5: drop SELECT INTO from the table-creating verb set",
    witness: [
      "control R3-29: SELECT ... INTO creates a P0 domain table is reported as M4",
      "control R3-30: SELECT ... INTO creates a table with no tenant_id is reported as M5",
    ],
    from: '  "SELECT INTO",\n',
    to: "",
  },
  {
    file: LINT,
    // The rename destination stops becoming a target at all, for every
    // renameable object type: a table (or view, or foreign table) built
    // under an innocent name and renamed to a domain word afterward walks
    // past M4 again, exactly as it did before this task. Catches R3-23,
    // R3-26, R3-27 and R3-28 together.
    name: "M4: stop modelling ALTER ... RENAME TO as a target of the name it renames an object to",
    // The declared non-coverage that used to stand here was reasoned rather
    // than tested, and was wrong: M4 is NOT the only consumer of a RENAME TO
    // target. The unqualified-name refusal reads every target, so the name an
    // object is renamed to is reported when it carries no schema qualifier -
    // and that report exists only while this scan runs. R7-9 asserts it, and
    // the mutation below (which leaves the scan running and stops M4 reading
    // its verb) leaves it standing.
    witness: "control R7-9: an object is renamed to an unqualified name is reported as M1",
    from: "  scan(\n    new RegExp(\n      String.raw`\\bALTER\\s+${RENAMEABLE_TYPES}\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${ID})(?:\\.(${ID}))?\\s+RENAME\\s+TO\\s+(${ID})`,\n      \"gi\",\n    ),\n    (m) => {\n      const kind = relationKind(m[1]);\n      if (m[3] === undefined) pushResolved(null, m[4], m[0], \"RENAME TO\", kind);\n      else pushResolved(m[2], m[4], m[0], \"RENAME TO\", kind);\n    },\n  );",
    to: "  void 0;",
  },
  {
    file: LINT,
    // Narrower than the mutation above: the scan still runs and the target
    // still exists, but M4's own filter stops accepting the RENAME TO verb,
    // so the target it produces is never checked against a domain stem.
    name: "M4: stop accepting RENAME TO as a verb this rule checks",
    witness:
      "control R3-23: ALTER TABLE ... RENAME TO renames a table to a domain word is reported as " +
      "M4",
    from: '      if (!TABLE_CREATING_VERBS.has(target.verb) && target.verb !== "RENAME TO") continue;',
    to: "      if (!TABLE_CREATING_VERBS.has(target.verb)) continue;",
  },
  {
    file: LINT,
    // Round three review of this task's first pass, CRITICAL: the RENAME TO
    // scan recognised only the literal keyword TABLE, so ALTER VIEW / ALTER
    // FOREIGN TABLE / ALTER MATERIALIZED VIEW ... RENAME TO all walked past
    // M4 despite their CREATE forms being in TABLE_CREATING_VERBS. Narrowing
    // the alternation back to just TABLE reproduces that exact regression.
    // Catches R3-26, R3-27 and R3-28 (R3-23's plain-table rename still
    // matches TABLE alone, so it alone would not catch this).
    name: "M4: narrow the RENAME TO alternation back to the literal keyword TABLE",
    witness:
      "control R3-26: ALTER VIEW ... RENAME TO renames a view to a domain word is reported as " +
      "M4",
    from: "const RENAMEABLE_TYPES = String.raw`(FOREIGN\\s+TABLE|MATERIALIZED\\s+VIEW|VIEW|TABLE)`;",
    to: "const RENAMEABLE_TYPES = String.raw`(TABLE)`;",
  },
  {
    file: LINT,
    // relationKind stops distinguishing a foreign table from a plain table,
    // so its M4/M5 message says "table" instead - a defect in this project,
    // since every control asserts on the message. Caught by R3-22 (CREATE
    // FOREIGN TABLE) and R3-27 (ALTER FOREIGN TABLE ... RENAME TO).
    name: "M4/M5: relationKind stops labelling a foreign table as one",
    witness:
      "control R3-27: ALTER FOREIGN TABLE ... RENAME TO renames a foreign table to a domain " +
      "word is reported as M4",
    from: '  if (normalised === "FOREIGN TABLE") return "foreign table";',
    to: "  if (false) return \"foreign table\";",
  },
  {
    file: LINT,
    // Same defect, the view/materialized-view half. Caught by R3-24, R3-25,
    // R3-26 and R3-28.
    name: "M4/M5: relationKind stops labelling a view as one",
    witness:
      "control R3-28: ALTER MATERIALIZED VIEW ... RENAME TO renames a materialized view to a " +
      "domain word is reported as M4",
    from: '  if (normalised === "VIEW" || normalised === "MATERIALIZED VIEW") return "view";',
    to: "  if (false) return \"view\";",
  },
  {
    file: LINT,
    name: "M5: stop requiring tenant_id",
    witness: "baseline: a tenant-owned table without tenant_id is reported as M5",
    from: '    if (created && !/\\btenant_id\\b/i.test(statement)) {',
    to: '    if (false) {',
  },
  {
    file: LINT,
    name: "M5: make the not-tenant-owned marker file-wide again",
    witness: "baseline: a not-tenant-owned marker leaking to a later table is reported as M5",
    from: '      if (exemptStatements.has(statement)) {',
    to: '      if (exemptStatements.size > 0) {',
  },
  {
    file: LINT,
    name: "M6: stop rejecting an unregistered migration directory",
    witness:
      "control 7 second form: a migration directory that names no registered module is reported " +
      "as M6",
    from: '    if (!schemaOf.has(entry)) {',
    to: '    if (false) {',
  },
  {
    file: LINT,
    name: "walk: revert to a non-recursive directory read",
    witness: "control 4: a migration in a nested directory is reported as M1",
    from: "      if (statSync(full).isDirectory()) walk(full);",
    to: "      if (statSync(full).isDirectory()) continue;",
  },
  {
    file: LINT,
    name: "scrub: blank literals in a separate pass, as before (the apostrophe hole)",
    witness: "control R3-1: an apostrophe inside a double-quoted identifier is reported as M1",
    from: '      if (!/^[A-Za-z0-9_]+$/.test(inner)) oddIdentifiers.push(inner);',
    to: "      if (false) oddIdentifiers.push(inner);",
  },
  {
    file: LINT,
    name: "scrub: stop refusing a non-ASCII character in an unquoted identifier",
    witness: "control R3-2: a non-ASCII character in an unquoted identifier is reported as M1",
    from: "    if (sql.codePointAt(i) > 127) {\n      nonAscii.add(sql[i]);\n      out.push(sql[i]);\n    } else {",
    to: "    if (false) {\n      nonAscii.add(sql[i]);\n      out.push(sql[i]);\n    } else {",
  },
  {
    file: LINT,
    name: "M1: stop refusing a dollar-quoted body",
    witness: "control R3-3: a dollar-quoted body this lint cannot read is reported as M1",
    from: "  if (dollarQuoted > 0) {",
    to: "  if (false) {",
  },
  {
    file: LINT,
    name: "M6: skip a non-directory under the migrations root, as before",
    witness: "control R3-4: a migration file directly under the migrations root is reported as M6",
    from: "    if (!statSync(dir).isDirectory()) {",
    to: "    if (!statSync(dir).isDirectory()) { continue; } if (false) {",
  },
  {
    file: LINT,
    name: "walk: match the .sql extension case-sensitively again",
    witness: "control R3-6: a .SQL file is read despite the uppercase extension",
    from: '      else if (entry.toLowerCase().endsWith(".sql")) found.push(full);',
    to: '      else if (entry.endsWith(".sql")) found.push(full);',
  },
  {
    file: LINT,
    name: "walk: stop reporting a file this lint would not read",
    witness:
      "control R3-5: a file under a migration directory that this lint would not read is " +
      "reported as M6",
    from: "      else others.push(full);",
    to: "      else if (false) others.push(full);",
  },

  // ---- round three open findings 9 and 10: reads and structural coupling
  // across a schema boundary -------------------------------------------------
  //
  // CROSS_SCHEMA_READ_KEYWORDS is one alternation of six independently
  // deletable entries. Each mutation below drops exactly one, the same
  // pattern TABLE_CREATING_VERBS' per-entry mutations above use, and each is
  // caught by that one clause's own fixture (R3-31..R3-36) - not by any
  // other, so a mutation that drops JOIN and survives because FROM's fixture
  // still reports the file would be exactly the "message-shape coverage,
  // not extractor coverage" defect three earlier review rounds found.
  {
    file: LINT,
    name: "M1: stop treating FROM as a cross-schema read",
    witness:
      "control R3-31: CREATE TABLE ... AS SELECT ... FROM reads another module's schema is " +
      "reported as M1",
    from: '  "FROM",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating JOIN as a cross-schema read",
    witness: "control R3-32: a JOIN reads another module's schema is reported as M1",
    from: '  "JOIN",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating USING as a cross-schema read",
    witness: "control R3-33: DELETE ... USING reads another module's schema is reported as M1",
    from: '  "USING",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating PARTITION OF as a cross-schema structural coupling",
    witness:
      "control R3-34: PARTITION OF structurally couples to another module's schema is reported " +
      "as M1",
    from: '  "PARTITION\\\\s+OF",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating INHERIT/INHERITS as a cross-schema structural coupling",
    witness:
      "control R3-35: INHERITS structurally couples to another module's schema is reported as " +
      "M1",
    from: '  "INHERITS?",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating LIKE as a cross-schema structural coupling",
    witness:
      "control R3-36: LIKE copies column definitions from another module's schema is reported " +
      "as M1",
    from: '  "LIKE",\n',
    to: "",
  },
  {
    file: LINT,
    // Round three open finding 10, first half: reverts exactly to the
    // pre-task regex, which required a trailing "(" - an explicit
    // referenced-column list - immediately after the referenced name, so
    // `REFERENCES othertable` with no column list at all matched nothing.
    // Caught by R3-37, not by the qualified branch above it (that branch
    // only ever fires on a schema-qualified REFERENCES, a different shape).
    name: "M2: require a column list again, so a bare REFERENCES escapes M2",
    witness: "control R3-37: an unqualified REFERENCES with no column list is reported as M2",
    from: 'const unqualified = new RegExp(String.raw`\\bREFERENCES\\s+(${ID})(?![\\w.])`, "gi");',
    to: 'const unqualified = new RegExp(String.raw`\\bREFERENCES\\s+(${ID})\\s*\\(`, "gi");',
  },
  {
    file: LINT,
    // A psql meta-command carries no SQL verb at all, so this is its own
    // check rather than left to the deny-by-default refusal to catch by
    // accident. Disabling it here still leaves the line refused by that
    // other, unrelated path (no target resolves from a line starting `\`),
    // but under the GENERIC "cannot resolve what schema the statement
    // touches" message, not "a psql meta-command" - R3-38 asserts the
    // specific message, not just that the file is refused at all, so this
    // mutation is caught by the message assertion even though the file
    // stays refused.
    name: "M1: stop refusing a psql meta-command as its own check",
    witness: "control R3-38: a psql meta-command is refused outright is reported as M1",
    from: "      if (!/^[ \\t]*\\\\/.test(line)) return line;",
    to: "      if (true) return line;",
  },

  // ---- task 3 review, Important finding 1: a schema-qualified CALL in
  // expression position (a column DEFAULT or CHECK) --------------------------
  //
  // One rule, not two: DEFAULT and CHECK carry no clause-introducing keyword
  // of their own, so the fix is ONE scan for the shape "schema-qualified
  // name immediately followed by (" anywhere in the statement, not two
  // keyword-anchored branches the way CROSS_SCHEMA_READ_KEYWORDS' entries
  // are. There is therefore no way to disable "just the DEFAULT case" or
  // "just the CHECK case" at the code level without disabling the other -
  // that would require re-introducing the exact per-context anchor list
  // constraint 10 rules out. This single mutation removes the scan
  // entirely and is witnessed by BOTH R3-39 (DEFAULT) and R3-40 (CHECK)
  // independently going red, which is the intended proof that the
  // generalised fix actually covers both named shapes rather than one.
  {
    file: LINT,
    name: "M1: stop scanning for a schema-qualified function call in expression position",
    witness: [
      "control R3-39: a column DEFAULT calls a function in another module's schema is reported as M1",
      "control R3-40: a CHECK constraint calls a function in another module's schema is reported as M1",
    ],
    from: 'String.raw`(?<!::\\s*)(?<!\\bCREATE\\s+${MODIFIERS}${RENAMEABLE_TYPES.replace("(", "(?:")}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)\\b(${ID})\\.(${ID})\\s*\\(`,',
    to: "String.raw`(?!)`,",
  },

  // ---- task 3 re-review, findings 1 and 2: the EXPR CALL scan over-fires on
  // two constructs that share its exact textual shape without being a call --
  {
    file: LINT,
    // Finding 1: a schema-qualified TYPE CAST carrying a precision/scale/
    // length modifier (`'0'::pg_catalog.numeric(10,2)`) is ordinary, legal
    // PostgreSQL, not a call. Without the `(?<!::\s*)` guard, the conforming
    // fixture 0002_typmod_cast_not_a_call.sql - three such casts, none
    // touching any schema this test suite's directories own - is reported
    // for M1 against "pg_catalog", and the conforming-fixtures test (which
    // requires the whole directory to pass with zero violations) goes red.
    // Not witnessed by a violating-fixture control, because the fixture this
    // guard protects is, by definition, one that must NOT be reported.
    name: "EXPR CALL: stop excluding a schema-qualified type cast's typmod from the call shape",
    witness: "control R7-2: a schema-qualified type cast carrying a typmod is not read as a call",
    from: 'String.raw`(?<!::\\s*)(?<!\\bCREATE\\s+${MODIFIERS}${RENAMEABLE_TYPES.replace("(", "(?:")}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)\\b(${ID})\\.(${ID})\\s*\\(`,',
    to: 'String.raw`(?<!\\bCREATE\\s+${MODIFIERS}${RENAMEABLE_TYPES.replace("(", "(?:")}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)\\b(${ID})\\.(${ID})\\s*\\(`,',
  },
  {
    file: LINT,
    // Finding 2: a CREATE TABLE/FOREIGN TABLE/VIEW/MATERIALIZED VIEW's own
    // qualified name, immediately followed by its column list, is a relation
    // DEFINITION, not a call - the CREATE/ALTER/DROP scan already resolves
    // this statement's real target from the identical text. This guard can
    // never be witnessed by "a conforming fixture goes red": the relation
    // being CREATEd always shares its directory's own schema in a conforming
    // fixture, so the extra EXPR CALL push is schema-equal and silently
    // harmless with or without the guard. It is witnessed instead by an
    // EXACT-COUNT test on a genuinely cross-schema CREATE TABLE
    // (rr_create_table_targets_tenancy_reported_once.sql, under violating/
    // audit/): with the guard removed, that one statement is reported for M1
    // twice, not once, and the test asserts the count is exactly 1.
    name: "EXPR CALL: stop excluding a relation's own column list from the call shape",
    witness: "finding 2: a cross-schema CREATE TABLE is reported for M1 exactly once, not twice",
    from: 'String.raw`(?<!::\\s*)(?<!\\bCREATE\\s+${MODIFIERS}${RENAMEABLE_TYPES.replace("(", "(?:")}\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)\\b(${ID})\\.(${ID})\\s*\\(`,',
    to: 'String.raw`(?<!::\\s*)\\b(${ID})\\.(${ID})\\s*\\(`,',
  },

  // ---- task 3 re-review, finding 3: DEC-016's case-folding defect, pulled
  // into this round by ruling ---------------------------------------------
  {
    file: LINT,
    // scrub() unquoted every double-quoted identifier and lower-cased its
    // inner text, but pushed unquoted "code" - including an unquoted
    // identifier - through unchanged. PostgreSQL folds every unquoted
    // identifier to lower case; without this, a schema written in a
    // different case than the registry's compares literally and is treated
    // as foreign. Witnessed by the conforming fixture
    // 0004_own_schema_different_case.sql (CREATE SCHEMA IF NOT EXISTS
    // TENANCY; CREATE TABLE Tenancy.mixed_case_ok (...)), which goes red
    // without this fold, both for the bare schema name and the
    // schema-qualified table name.
    name: "scrub: stop folding an unquoted ASCII character to lower case",
    witness:
      "control R7-5: a schema written in a different case than the registry's is the same " +
      "schema",
    from: "      out.push(sql[i].toLowerCase());",
    to: "      out.push(sql[i]);",
  },

  // ---- task 3 round two re-review, follow-up to finding 1: a schema-
  // qualified TYPE REFERENCE in cast position -----------------------------
  {
    file: LINT,
    // The coordinator's own ruling: `(?<!::\s*)` correctly stopped a typmod
    // cast from being misidentified as a CALL, but left the cast itself
    // undetectable as a reference to another module's TYPE, with or without
    // a typmod. Disabling the whole scan is witnessed by BOTH R5-1 (with a
    // typmod) and R5-2 (without one) independently going red - the same
    // "one mutation, two independent witnesses" shape the EXPR CALL scan's
    // own removal mutation above uses for R3-39/R3-40.
    name: "CAST TYPE: stop scanning for a schema-qualified type reference in cast position",
    witness: [
      "control R5-1: a type cast with a typmod crosses a schema boundary is reported as M1",
      "control R5-2: a type cast with no typmod crosses a schema boundary is reported as M1",
    ],
    from: 'String.raw`::\\s*(${ID})\\.(${ID})`, "gi"), (m) => pushMention(m[1], m[2], m[0], "CAST TYPE"));',
    to: 'String.raw`(?!)`, "gi"), (m) => pushMention(m[1], m[2], m[0], "CAST TYPE"));',
  },
  {
    file: LINT,
    // The registry-membership half of the CAST TYPE guard: without it, a
    // cast to a schema no module owns (pg_catalog, information_schema) is
    // reported exactly like a cast to a real foreign module's schema, which
    // is the false positive finding 1 fixed and this task must not
    // reintroduce. Witnessed by 0005_cast_type_own_schema_and_builtin.sql
    // going red on its pg_catalog and information_schema columns (its
    // own-schema columns would ALSO go red from this same mutation, since
    // every schema, including this directory's own, is trivially "not in
    // knownSchemas" once the check is removed entirely - but the point of
    // THIS mutation is the registry half specifically, so `target.schema
    // !== schema` is left standing and only the membership check is cut).
    name: "M1: stop filtering CAST TYPE targets by registry membership",
    witness: "control R7-3: a cast to a schema no registered module owns is not a cross-schema reach",
    from: "if (knownSchemas.has(target.schema) && target.schema !== schema) {",
    to: "if (target.schema !== schema) {",
  },
  {
    file: LINT,
    // The schema-equality half of the same guard: without it, a cast to
    // this directory's OWN schema (trivially a member of `knownSchemas`,
    // since this directory is itself a registered module) is reported as
    // touching a foreign schema. Witnessed by
    // 0005_cast_type_own_schema_and_builtin.sql going red on its two
    // own-schema columns.
    name: "M1: stop excluding a CAST TYPE target that names this directory's own schema",
    witness: "control R7-4: a cast to this directory's own schema is not a cross-schema reach",
    from: "if (knownSchemas.has(target.schema) && target.schema !== schema) {",
    to: "if (knownSchemas.has(target.schema)) {",
  },

  // ---- round four -------------------------------------------------------
  {
    file: LINT,
    // C1: `SET` was the one entry on the harmless-leading-verb list, on the
    // stated reasoning that a bare `SET <parameter> = <value>` cannot reach
    // another module's schema. `SET SCHEMA 'audit'` proved that false. The
    // list is gone; this puts the exemption back by hand, in the smallest
    // form that reproduces it. Caught by R6-2 (a plain session SET is
    // refused because nothing resolves a target from it) - NOT by R6-1,
    // which the explicit session-schema refusal below still reports.
    name: "M1: exempt a statement opening with SET from the deny-by-default refusal again",
    witness:
      "control R6-2: a statement opening with SET is no longer presumed harmless is reported as " +
      "M1",
    from:
      '  return { targets, understood: targets.some((t) => t.resolvesStatement) };',
    to:
      '  return { targets, understood: targets.some((t) => t.resolvesStatement) || /^\\s*SET\\b/i.test(statement) };',
  },
  {
    file: LINT,
    // The other half of C1: the explicit refusal of the SESSION-level
    // schema statement, whatever spelling its argument takes. Caught by
    // R6-1's message assertion - the file stays reported either way, by
    // the deny-by-default path, but only this check produces the message
    // that names what the statement actually does.
    name: "M1: stop refusing a session SET that changes schema resolution",
    witness:
      "control R6-1: SET SCHEMA with a string literal changes schema resolution for the whole " +
      "file is reported as M1",
    from:
      "    if (/^\\s*SET\\s+(?:LOCAL\\s+|SESSION\\s+)?SCHEMA\\b/i.test(statement)) {",
    to: '    if (false) {',
  },
  {
    file: LINT,
    // I2: an incidental mention (a schema-qualified call shape, a cast, a
    // FROM clause) satisfying `understood` is exactly how round three's
    // deny-by-default was undone from the inside by round three's own
    // later extractors. Caught by R6-3, whose statement resolves no
    // target at all but does carry an own-schema call shape.
    name: "M1: let an incidental mention satisfy the deny-by-default refusal again",
    witness:
      "control R6-3: an unmodelled statement carrying an incidental own-schema call shape is " +
      "reported as M1",
    from:
      '  return { targets, understood: targets.some((t) => t.resolvesStatement) };',
    to: '  return { targets, understood: targets.length > 0 };',
  },
  {
    file: LINT,
    // I3: the whole declaration-position type scan. Caught by R6-4.
    name: "M1: stop scanning for a schema-qualified type in declaration position",
    witness: "control R7-1: a column ADDED with a type in another module's schema is reported as M1",
    from:
      'String.raw`(?:${TYPE_POSITIONS.join("|")})(${ID})\\.(${ID})`,',
    to: 'String.raw`(?!)`,',
  },
  {
    file: LINT,
    // I3, the narrower half: only the column-definition position, which is
    // the one the finding reproduced. The other four entries stay, so this
    // is not the same mutation as removing the scan. Caught by R6-4.
    name: "M1: stop reading a relation's own column list as a type position",
    witness: "control R6-4: a column declared with a type in another module's schema is reported as M1",
    from: '  String.raw`[(,]\\s*${ID}\\s+`,\n',
    to: "",
  },
  {
    file: LINT,
    // Round five ruling, closing what this task's own attribution measured:
    // TYPE_POSITIONS is one alternation of five, and entries 3, 4 and 5 could
    // each be deleted with the whole suite staying green. Three fixtures,
    // three controls and these three mutations, in the shape R7-1 already
    // uses for entry 2.
    name: "M1: stop reading ALTER ... TYPE as a type position",
    witness:
      "control R7-6: a column RETYPED to a type in another module's schema is reported as M1",
    from: '  String.raw`\\bALTER\\s+(?:COLUMN\\s+)?${ID}\\s+(?:SET\\s+DATA\\s+)?TYPE\\s+`,\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop reading a function's RETURNS clause as a type position",
    witness:
      "control R7-7: a function RETURNS a type in another module's schema is reported as M1",
    from: '  String.raw`\\bRETURNS\\s+(?:SETOF\\s+)?`,\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop reading a domain's underlying type as a type position",
    witness:
      "control R7-8: a domain is built on a type in another module's schema is reported as M1",
    from: '  String.raw`\\bCREATE\\s+DOMAIN\\s+(?:${ID}\\.)?${ID}\\s+AS\\s+`,\n',
    to: "",
  },
  {
    file: LINT,
    // I4, first half: `INHERIT` (singular) is a different keyword from
    // `INHERITS`, and the ALTER form was never matched. Narrowing the
    // alternation back to the plural reproduces exactly that. Caught by
    // R6-5, not by R3-35 (whose CREATE form still says INHERITS).
    name: "M1: narrow the INHERITS alternation back to the plural CREATE spelling",
    witness:
      "control R6-5: ALTER TABLE ... INHERIT couples to another module's schema is reported as " +
      "M1",
    from: '  "INHERITS?",\n',
    to: '  "INHERITS",\n',
  },
  {
    file: LINT,
    // I4, second half: `ATTACH PARTITION` is its own entry beside
    // `PARTITION OF`, and is independently deletable. Caught by R6-6.
    name: "M1: stop treating ATTACH PARTITION as a cross-schema structural coupling",
    witness:
      "control R6-6: ALTER TABLE ... ATTACH PARTITION couples to another module's schema is " +
      "reported as M1",
    from: '  "ATTACH\\\\s+PARTITION",\n',
    to: "",
  },
  {
    file: LINT,
    // I5: M3's two sub-checks were anchored to the literal keywords
    // `ALTER TABLE`. Re-anchoring reproduces it for both at once, so each
    // sub-check also gets its own narrower mutation below. Caught by R6-7,
    // R6-8 and R6-9; the plain ALTER TABLE controls stay green, which is
    // the point.
    name: "M3: anchor both audit sub-checks back to the literal keywords ALTER TABLE",
    witness: [
      "control R6-7: a column drop on an audit FOREIGN TABLE is reported as M3",
      "control R6-8: a column type change on an audit FOREIGN TABLE is reported as M3",
      "control R6-9: a column type change on an audit MATERIALIZED VIEW is reported as M3",
    ],
    from:
      "      const alterRelation = String.raw`\\bALTER\\s+${RENAMEABLE_TYPES}\\b`;",
    to: "      const alterRelation = String.raw`\\bALTER\\s+TABLE\\b`;",
  },
  {
    file: LINT,
    // Round four residual 2: the third spelling of the act C1 refuses.
    // `set_config('search_path', 'audit', false)` IS `SET search_path TO
    // audit`, and wrapping it in a statement whose own target resolves
    // defeated deny-by-default as well as both explicit checks. Caught by
    // R6-11's message assertion: with this off, the fixture's INSERT
    // resolves its own target, is understood, and the file passes outright.
    name: "M1: stop refusing a set_config() call that can change the session search_path",
    witness:
      "control R6-11: set_config() changes the session search_path from inside a resolved " +
      "statement is reported as M1",
    from: "    if (/\\bset_config\\s*\\(/i.test(statement)) {",
    to: '    if (false) {',
  },
  {
    file: LINT,
    // The single-quoted function body: as unreadable to this lint as a
    // dollar-quoted one, and refused only in the $$ spelling before.
    // Caught by R6-10.
    name: "M1: stop refusing a function body written as a single-quoted string literal",
    witness:
      "control R6-10: a function body written as a single-quoted string literal is reported as " +
      "M1",
    from:
      "      /\\b(?:CREATE|ALTER)\\s+(?:OR\\s+REPLACE\\s+)?(?:FUNCTION|PROCEDURE)\\b[\\s\\S]*\\bAS\\s+''/i.test(",
    to: '      /(?!)/.test(',
  },

  // ---- round four finding I9: the two instruments in `verify` and in CI that
  // no test had ever spawned ------------------------------------------------
  //
  // scripts/coverage-gate.mjs is the instrument built to answer "is every
  // named protection witnessed by something?", and `return 0;` as the first
  // statement of its main() made it print nothing, exit 0, and `pnpm verify`
  // sail through. scripts/generate-codeowners.mjs is 389 lines deciding who
  // reviews what, with no test at all. Both are now spawned by
  // tests/boundaries/coverage-gate.test.mjs and
  // tests/boundaries/generate-codeowners.test.mjs, so both are reachable from
  // this sweep.
  {
    file: GATE,
    // The finding verbatim. Caught by the PASS-line assertion: a gate that
    // returns before checking anything prints no count at all.
    name: "coverage gate: return 0 before checking any protection",
    witness: "the coverage gate passes on this repository and reports what it checked",
    from: "function main() {\n  let registry;",
    to: "function main() {\n  return 0;\n  let registry;",
  },
  {
    file: GATE,
    // Round four residual 1, and the reason the seam is an argument rather
    // than an environment variable. The first version of it read
    // process.env.COVERAGE_GATE_TEST_TESTS_DIR, so one exported variable
    // redirected the gate AND every one of its own witnesses at once - the
    // tests spawn it with the ambient environment, and runSuite (above)
    // forwards the ambient environment into this very sweep, so nothing here
    // would have seen it either. This restores exactly that, and is caught by
    // the argv/environment witness, which points the retired variable at two
    // EMPTY test files and requires the gate to keep reading the repository.
    name: "coverage gate: honour an ambient COVERAGE_GATE_TEST_TESTS_DIR again",
    witness: "the coverage gate reads its own argv and cannot be redirected by the environment",
    from: "const TESTS_DIR = testsDirFromArgv();",
    to: "const TESTS_DIR = testsDirFromArgv() ?? process.env.COVERAGE_GATE_TEST_TESTS_DIR;",
  },
  {
    file: GATE,
    // Caught twice over: the independently-derived count in the PASS-line
    // test drops by four, and the unwitnessed-verb test stops being reported.
    name: "coverage gate: stop asking whether the audit verbs are witnessed",
    witness: "the coverage gate refuses an audit verb no control asserts",
    from: "  for (const verb of AUDIT_FORBIDDEN) {",
    to: "  for (const verb of []) {",
  },
  {
    file: GATE,
    name: "coverage gate: stop asking whether the P0 domain stems are witnessed",
    witness: "the coverage gate refuses a P0 domain stem no control asserts",
    from: "  for (const { label } of P0_FORBIDDEN_TABLE_STEMS) {",
    to: "  for (const { label } of []) {",
  },
  {
    file: GATE,
    name: "coverage gate: stop asking whether the generated rule families are witnessed",
    witness: "the coverage gate refuses a generated rule family no control names",
    from: "  for (const family of [...families].sort()) {",
    to: "  for (const family of []) {",
  },
  {
    file: GATE,
    // The narrowest and nastiest of the five: the gate still finds every gap
    // and still prints it, and returns 0 anyway. A gate that reports and does
    // not gate is exactly what three review rounds kept finding one level
    // down. Caught by the exit-code assertion in all three failure tests -
    // none of which would notice on the message alone.
    name: "coverage gate: report every gap but exit 0 anyway",
    witness: [
      "the coverage gate refuses an audit verb no control asserts",
      "the coverage gate refuses a P0 domain stem no control asserts",
      "the coverage gate refuses a generated rule family no control names",
    ],
    shared:
      "declared non-coverage. This is the exit code, not the report: the gate still finds every " +
      "gap and still prints it. What proves it is the exit-code assertion inside each of the " +
      "three refusal tests above, which are the declared witnesses of the three loop mutations. " +
      "A fourth test asserting the same exit code on the same seam would be a copy of one of " +
      "them, not an independent control - the honest record is that this mutation is witnessed " +
      "by an assertion those three carry, not by a fixture of its own.",
    from: lines("    );", "    return 1;", "  }", "", "  process.stdout.write("),
    to: lines("    );", "    return 0;", "  }", "", "  process.stdout.write("),
  },
  {
    file: CODEOWNERS,
    // --check is the entire enforcement: without it a hand edit of the
    // generated routing file stands. Caught by the stale/missing test, which
    // makes a real stale copy through the CODEOWNERS_TEST_OUT seam.
    name: "codeowners: --check accepts a stale generated file",
    witness: "--check refuses a stale file and refuses a missing one",
    from: "    if (found !== content) {",
    to: "    if (false) {",
  },
  {
    file: CODEOWNERS,
    // A routing entry with no owner or no verifier becomes an UNOWNED
    // governance path rather than a refusal - which is how a review
    // requirement disappears with nothing recording that.
    name: "codeowners: stop refusing a routing entry that records no owner or verifier",
    witness: "a routing entry recording no owner or no verifier is refused",
    from: "        throw new RegistryError(`routing entry ${path || \"?\"} records no ${label}`);",
    to: "        continue;",
  },
  {
    file: CODEOWNERS,
    // The seat stops being emitted at all: every path becomes unowned. Caught
    // by the team-slug test and by the byte-equality test against the real
    // .github/CODEOWNERS.
    name: "codeowners: emit no team slug for a seat that names a declared role",
    witness: "a routing entry naming a declared role emits that role's TEAM slug",
    from: "        teams.push(`@${ORG}/${value}`);",
    to: "        void 0;",
  },
  {
    file: CODEOWNERS,
    // The forgery this generator exists to refuse: a bare @handle asserts that
    // some named account owns the path, where a team slug asserts only that a
    // seat does - and who holds a seat is a fact badf/agents.yaml records and
    // badf/bootstrap.yaml alone may seat, not something a CODEOWNERS line asserts.
    // Caught by the never-a-person test.
    name: "codeowners: emit a bare handle instead of a team slug under the organisation",
    witness: "the generator never emits a person, only a team slug under the org",
    from: "        teams.push(`@${ORG}/${value}`);",
    to: "        teams.push(`@${value}`);",
  },
  {
    file: CODEOWNERS,
    // The one routing entry whose owner is prose rather than a seat is emitted
    // as a NOTE, not silently dropped - dropping it would make the file claim
    // that path has a verifier and no owner. Caught by the prose test and by
    // the byte-equality test.
    name: "codeowners: drop the note for an owner that names no fixed seat",
    witness: "a routing entry whose owner is prose emits a note and no ownership line",
    from: "      lines.push(`# ${path}: ${notes.join(\"; \")}`);",
    to: "      void 0;",
  },

  // ---- round four findings I6, I7 and I8: the record validator ------------
  //
  // Every mutation below names `suite: "validator"`. scripts/validate_continuity.py
  // is not exercised by the boundary suite at all - its witnesses live in
  // tests/unit, run by `pnpm test:validator` - so a mutation to it checked
  // against the boundary suite would survive every time and prove the
  // opposite of what it looks like it proves.
  {
    file: RECORDS,
    suite: "validator",
    // I7: the routing block generates .github/CODEOWNERS, and was validated
    // for PRESENCE only - so rerouting badf/authority.yaml to two seats an
    // agent may occupy passed both validate:records and codeowners:check.
    // This drops the whole pin.
    name: "records: stop pinning the routing entries of the governance registries",
    witness: "test_deleting_a_governance_routing_entry_is_reported",
    from: "    for path, (owner, verifier) in sorted(PINNED_ROUTING.items()):",
    to: "    for path, (owner, verifier) in []:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The narrower half: the pinned path is still required to EXIST, but may
    // be routed anywhere. Caught by the reroute witness, not by the deletion
    // witness - which is the point of having both.
    name: "records: let a pinned governance path be routed to any seat",
    witness: "test_rerouting_a_governance_path_to_agent_occupiable_seats_is_reported",
    from: lines("            if actual == expected:", "                continue"),
    to: lines("            if True:", "                continue"),
  },
  {
    file: RECORDS,
    suite: "validator",
    // A routing owner or verifier that names no declared role generates no
    // CODEOWNERS line at all: the path is unreviewed while reading as though
    // it were routed.
    name: "records: stop requiring a routing owner or verifier to name a declared role",
    witness: "test_a_routing_verifier_naming_no_declared_role_is_reported",
    from: lines("            if ROLE_SHAPED.fullmatch(value) is None:", "                continue"),
    to: lines("            if True:", "                continue"),
  },
  {
    file: RECORDS,
    suite: "validator",
    // I6: the routing presence loop. Witnessed by the UNPINNED "modules/**"
    // entry losing its verifier - a pinned path would be caught by
    // PINNED_ROUTING instead and this would survive.
    name: "records: stop refusing a routing entry that records no path, owner or verifier",
    witness: "test_a_routing_entry_with_no_verifier_is_reported",
    from: '        for field in ("path", "owner", "verifier"):',
    to: "        for field in ():",
  },
  {
    file: RECORDS,
    suite: "validator",
    // I8: the floor half of the skills roster - every pinned id recorded, at
    // or above its pin. Drops the deletion refusal and the widening refusal
    // together.
    name: "records: stop checking the pinned skill roster at all",
    witness: "test_deleting_record_a_gate_is_reported",
    from: "    for skill_id, pinned in sorted(PINNED_SKILL_STATUS.items()):",
    to: "    for skill_id, pinned in []:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Narrower: the pinned ids must still all be PRESENT, but any status is
    // accepted. This is `write-a-migration: BLOCKED -> AVAILABLE`, exactly.
    name: "records: accept any status on a pinned skill, so a BLOCKED skill can be made AVAILABLE",
    witness: "test_making_a_blocked_skill_available_is_reported",
    from: "        if SKILL_STATUS_RANK.get(status, -1) < SKILL_STATUS_RANK[pinned]:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // I8's superset half: without it the pin is a floor the data can outgrow
    // - a new skill, at any status, is simply unprotected.
    name: "records: stop requiring every recorded skill to be pinned in the validator",
    witness: "test_a_forbidden_skill_the_validator_does_not_pin_is_reported",
    from: lines("        if skill_id in PINNED_SKILL_STATUS:", "            continue"),
    to: lines("        if True:", "            continue"),
  },
  {
    file: RECORDS,
    suite: "validator",
    // I6: an empty registry is not a registry with nothing forbidden; it is
    // one that says nothing, which a caller reads as permission.
    name: "records: stop refusing a skills registry that records no skill",
    witness: "test_a_skills_registry_with_no_skill_is_reported",
    from: lines(
      "    if not entries:",
      '        errors.append("badf/skills.yaml: no skill is recorded")',
    ),
    to: lines("    if False:", '        errors.append("badf/skills.yaml: no skill is recorded")'),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop refusing a role registry that records no role",
    witness: "test_an_agents_registry_with_no_role_is_reported",
    from: lines(
      "    if not roles:",
      '        errors.append("badf/agents.yaml: no role is recorded")',
    ),
    to: lines("    if False:", '        errors.append("badf/agents.yaml: no role is recorded")'),
  },
  {
    file: RECORDS,
    suite: "validator",
    // I6, the three unknown-field refusals. These are the load-bearing half
    // of the "refuses every line it cannot classify" doctrine both readers
    // state at length: a field the reader silently drops is a field a human
    // reading the file still sees.
    name: "records: silently skip an unknown field on a skill instead of refusing it",
    witness: "test_an_unknown_field_on_a_skill_is_reported",
    from: "            if field not in SKILL_FIELDS:",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: silently skip an unknown field on a role instead of refusing it",
    witness: "test_an_unknown_field_on_a_role_is_reported",
    from: "                if field not in ROLE_FIELDS:",
    to: "                if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: silently skip an unknown field on a routing entry instead of refusing it",
    witness: "test_an_unknown_field_on_a_routing_entry_is_reported",
    from: "                if field not in ROUTING_FIELDS:",
    to: "                if False:",
  },

  // ---- round five: this harness's own attribution -------------------------
  //
  // scripts/mutation-attribution.mjs decides WHICH control caught a mutation,
  // and every refusal in it is a rule that can be loosened exactly as the
  // boundary rules and the migration lint can. It is pure for that reason:
  // its controls are ordinary tests rather than a nested sweep, so it is
  // reachable from here without this script having to spawn itself.
  {
    file: ATTRIBUTION,
    name: "attribution: read a control reported not ok as passing",
    witness: "TAP: only a control reported not ok is read as a killer",
    from: '    if (parsed[1] === "not ok") failed.push(name);',
    to: '    if (false) failed.push(name);',
  },
  {
    file: ATTRIBUTION,
    name: "attribution: keep a TAP SKIP directive as part of the control's name",
    witness: "TAP: every control the suite ran is read into the roster, skipped ones included",
    from: '      .replace(/\\s+#\\s+(?:SKIP|TODO)\\b.*$/, "")',
    to: '      .replace(/(?!)/, "")',
  },
  {
    file: ATTRIBUTION,
    name: "attribution: read an indented subtest result as a control of its own",
    witness: "TAP: an indented subtest result is not read as a second control",
    from: '    const parsed = /^(not ok|ok) [0-9]+ - (.*)$/.exec(line);',
    to: '    const parsed = /(not ok|ok) [0-9]+ - (.*)$/.exec(line);',
  },
  {
    file: ATTRIBUTION,
    name: "attribution: read a validator control that ERRORED as passing",
    witness: "unittest: a control that FAILED and a control that ERRORED are both killers",
    from: '    const failure = /^(?:FAIL|ERROR): (test_[A-Za-z0-9_]*) \\(/.exec(line);',
    to: '    const failure = /^(?:FAIL): (test_[A-Za-z0-9_]*) \\(/.exec(line);',
  },
  {
    file: ATTRIBUTION,
    name: "attribution: stop reading the validator's per-test line into the roster",
    witness: "unittest: the verbose per-test line is what puts a control in the roster",
    from: '    const ran = /^(test_[A-Za-z0-9_]*) \\(/.exec(line);',
    to: "    const ran = null;",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: accept an anchor that matches more than once",
    witness: "an anchor that appears twice is refused rather than rewriting the first copy",
    from: "  if (String(source).indexOf(from, first + 1) >= 0) {",
    to: "  if (false) {",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: accept an anchor that is not in the file at all",
    witness: "an anchor that is gone is refused as a mutation that stopped testing",
    from: "  if (first < 0) {",
    to: "  if (false) {",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: accept a mutation that declares no witness",
    witness: "a mutation that declares no witness is refused",
    from: "    if (witnesses.length === 0) {",
    to: "    if (false) {",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: accept a witness that names no test in its suite",
    witness: "a witness that names no test in its own suite is refused",
    from: "      if (!known.has(witness)) {",
    to: "      if (false) {",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: let a mutation borrow another's witness with no reason",
    witness: "borrowing a witness another mutation already claims is refused without a reason",
    from: "      if (reasonOf(entry) !== null) continue;",
    to: "      if (true) continue;",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: stop noticing two mutations no control tells apart",
    witness:
      "two mutations killed by exactly the same controls are refused unless one records a reason",
    from: "    if (group.length < 2) continue;",
    to: "    if (true) continue;",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: credit a declared witness that did not go red",
    witness: "only the declared witnesses that actually went red are credited",
    from: "  return witnessesOf(mutation).filter((name) => killers.includes(name));",
    to: "  return witnessesOf(mutation);",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: stop reporting the controls that kill more than one mutation",
    witness: "the overlap report names the controls that kill more than one mutation",
    from: "    multiplyKilling: [...kills].filter(([, victims]) => victims.length > 1),",
    to: "    multiplyKilling: [],",
  },
  {
    file: ATTRIBUTION,
    // The other direction, which had a control but no measurement: the
    // control did go red if deleted, so the number was not unwitnessed - it
    // was simply never MEASURED, and the shared fixture is why. Its half of
    // the split fixture is above.
    name: "attribution: stop reporting the mutations more than one control kills",
    witness: "the overlap report names the mutations more than one control kills",
    from: "    multiplyKilled: [...killedBy].filter(([, killers]) => killers.length > 1),",
    to: "    multiplyKilled: [],",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: stop reporting the mutations no control kills alone",
    witness: "the overlap report names the mutations no control kills alone",
    from: "      .filter(([, killers]) => killers.every((killer) => kills.get(killer).length > 1))",
    to: "      .filter(() => false)",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: accept a baseline suite that named no test at all",
    witness: "a baseline suite that named no test at all is refused",
    from: "  if (names.length === 0) {",
    to: "  if (false) {",
  },
  {
    file: ATTRIBUTION,
    name: "attribution: accept a baseline suite that named one control twice",
    witness: "a baseline suite that named one control twice is refused",
    from: "  if (duplicates.length > 0) {",
    to: "  if (false) {",
  },

  // ---- the verdict's own terms ------------------------------------------
  //
  // Review of this task deleted `misattributed` from what was then a
  // hand-written sum in main(), repointed a mutation at the wrong witness, and
  // watched the sweep PRINT the misattribution and exit 0 - `pnpm verify`
  // green with the whole attribution switched off. The sum is now one
  // alternation, so dropping a term is one deletable entry, and every entry is
  // a mutation with its own control. The controls are enumerated in the test
  // file INDEPENDENTLY of the alternation: derived from it, deleting a term
  // would delete its control too, and a control that no longer exists cannot
  // go red.
  {
    file: ATTRIBUTION,
    name: "verdict: a surviving mutation stops failing the run",
    witness: "the run fails when survived is not empty",
    from: '  ["survived", "survived"],\n',
    to: "",
  },
  {
    file: ATTRIBUTION,
    name: "verdict: a defective anchor stops failing the run",
    witness: "the run fails when anchorDefects is not empty",
    from: '  ["anchorDefects", "anchor(s) defective"],\n',
    to: "",
  },
  {
    file: ATTRIBUTION,
    name: "verdict: a mutation that declares no witness stops failing the run",
    witness: "the run fails when undeclared is not empty",
    from: '  ["undeclared", "declared no witness"],\n',
    to: "",
  },
  {
    file: ATTRIBUTION,
    name: "verdict: a witness that names no test stops failing the run",
    witness: "the run fails when unknownWitness is not empty",
    from: '  ["unknownWitness", "declared a witness that names no test"],\n',
    to: "",
  },
  {
    file: ATTRIBUTION,
    name: "verdict: an undeclared borrowed witness stops failing the run",
    witness: "the run fails when undeclaredSharing is not empty",
    from: '  ["undeclaredSharing", "borrowed a declared witness without saying so"],\n',
    to: "",
  },
  {
    file: ATTRIBUTION,
    name: "verdict: an indistinguishable pair stops failing the run",
    witness: "the run fails when undeclaredTwins is not empty",
    from: '  ["undeclaredTwins", "indistinguishable from another mutation"],\n',
    to: "",
  },
  {
    file: ATTRIBUTION,
    name: "verdict: a misattributed mutation stops failing the run",
    witness: "the run fails when misattributed is not empty",
    from: '  ["misattributed", "caught by something other than their witness"],\n',
    to: "",
  },
  {
    file: ATTRIBUTION,
    // The other half of the same hole: a term that cannot be silenced by
    // deleting its entry can still be silenced by not passing its bucket.
    name: "verdict: count a bucket it was never given as empty",
    witness: "a bucket the verdict was not given is a defect, not an empty bucket",
    from: "    if (!Object.hasOwn(buckets, key)) {",
    to: "    if (false) {",
  },
  // ---- who wrote the record: the signing policy and its check -------------
  //
  // Everything above this point mutates a rule about what a record may SAY.
  // These mutate the first rule in this repository about who WROTE one. The
  // ten `RECORDS` entries loosen the policy's own reader and shape rules; the
  // five below them loosen the second reader and the verification itself.
  //
  // The last one is the one worth reading twice. `SIGNING_CHECK NOT_ENFORCED`
  // is a status, not a comment: it is what stops an unenforced control from
  // being indistinguishable from an enforced one, which is the defect class
  // this whole branch exists to close. Deleting the branch that prints it
  // must go red, or the honesty of every future unenforced check in this
  // repository rests on nothing.
  {
    file: RECORDS,
    suite: "validator",
    // The reader's default. `problems.append(` becomes an assignment, so the
    // message is still computed and simply never reported - which is exactly
    // what the reader parse_authority replaced used to do to a line it did
    // not recognise.
    name: "records: silently skip a signing-policy line the reader cannot classify",
    witness: "test_a_line_the_signing_policy_grammar_cannot_classify_is_reported",
    from: lines(
      "        problems.append(",
      '            f"badf/signing-policy.yaml line {number}: matches no rule of this "',
    ),
    to: lines(
      "        _unclassified = (",
      '            f"badf/signing-policy.yaml line {number}: matches no rule of this "',
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: silently skip an unknown top-level key in the signing policy",
    witness: "test_an_unknown_top_level_key_in_the_signing_policy_is_reported",
    from: lines(
      "                problems.append(",
      '                    f"badf/signing-policy.yaml line {number}: unknown top-level key "',
    ),
    to: lines(
      "                _unknown_key = (",
      '                    f"badf/signing-policy.yaml line {number}: unknown top-level key "',
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: silently skip an unknown field on an accepted signing key",
    witness: "test_an_unknown_field_on_an_accepted_key_is_reported",
    from: "                if field not in SIGNING_KEY_FIELDS:",
    to: "                if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The enforcement point is the whole scope of the check. A value nothing
    // can resolve scopes it to nothing while the file still reads as a policy.
    name: "records: accept a signing-policy enforcement point that resolves to nothing",
    witness: "test_an_enforcement_point_that_is_neither_a_sha_nor_the_literal_is_reported",
    from: "    if point != ENFORCEMENT_POINT_LITERAL and COMMIT_SHA.match(point) is None:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Every protected path becomes a `git log` pathspec, and git reads a
    // leading dash as an OPTION.
    name: "records: stop refusing a protected path git would read as an option",
    witness: "test_a_protected_path_git_would_read_as_an_option_is_reported",
    from: '        if PROTECTED_PATH.match(path) is None or ".." in path.split("/"):',
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The floor. Deleting one line of badf/signing-policy.yaml would otherwise
    // stop badf/authority.yaml being a path any signature is ever required
    // for, with every other check in this repository still green.
    name: "records: stop pinning the protected-path floor of the signing policy",
    witness: "test_dropping_a_pinned_protected_path_is_reported",
    from: "        if pinned in recorded:",
    to: "        if True:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept a signing policy that never says whether a key is enrolled",
    witness: "test_a_policy_that_declares_no_accepted_keys_is_reported",
    from: "    if said is not None:",
    to: "    if False:",
  },
  // The four accepted_keys coherence branches, one mutation each. They had one
  // between them - the aggregation above - and one control, so three of the
  // four would have passed the sweep with the branch DELETED. Round six of the
  // same defect class, and this time inside the rule the comment on
  // ACCEPTED_KEY_RULES was written about.
  {
    file: RECORDS,
    suite: "validator",
    // The self-enrolment path: the file says the word a human greps for and
    // then hands the JS reader a live identity anyway.
    name: "records: accept a signing policy that says NONE_ENROLLED and then lists a key",
    witness: "test_a_policy_that_says_none_enrolled_and_then_lists_a_key_is_reported",
    from: "    elif inline == NO_KEYS_ENROLLED and keys:",
    to: "    elif False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept a signing policy that opens accepted_keys and lists nothing",
    witness: "test_a_policy_that_opens_accepted_keys_and_lists_no_key_is_reported",
    from: '    elif inline == "" and not keys:',
    to: "    elif False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept a signing policy that records accepted_keys as a third word",
    witness: "test_a_policy_that_records_accepted_keys_as_some_other_word_is_reported",
    from: '    elif inline not in ("", NO_KEYS_ENROLLED):',
    to: "    elif False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // ACCEPTED_KEY_RULES is one alternation for the reason VERDICT_TERMS in
    // mutation-attribution.mjs is: each rule is one deletable line, so each
    // can have a control of its own instead of three conditions sharing one.
    name: "records: drop the rule that an accepted key must record an identity",
    witness: "test_an_accepted_key_with_no_identity_is_reported",
    from:
      '    ("identity", None, "a non-empty signer identity, matched against git\'s own %GS and %GK"),\n',
    to: "",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: drop the rule that an accepted key's kind is one git can verify",
    witness: "test_an_accepted_key_whose_kind_git_cannot_verify_is_reported",
    from:
      '    ("kind", SIGNING_KEY_KINDS, f"one of {list(SIGNING_KEY_KINDS)}, the kinds git can verify"),\n',
    to: "",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The self-enrolment refusal, and the one rule here an agent would have a
    // motive to delete: without it a seat an agent may occupy can enrol the
    // identity that agent's own commits are signed as.
    name: "records: let a seat an agent may occupy enrol a signing key",
    witness: "test_a_key_enrolled_by_a_seat_an_agent_may_occupy_is_reported",
    from: lines(
      "    (",
      '        "enrolled_by",',
      "        AGENT_FORBIDDEN_ROLES,",
      '        f"one of {list(AGENT_FORBIDDEN_ROLES)} - enrolling a key is a human act, "',
      '        f"and a key an agent-occupiable seat enrolled binds nobody",',
      "    ),\n",
    ),
    to: "",
  },
  // ---- the bootstrap record: the one-time act that seats the first
  // occupant of a human-only seat -----------------------------------------
  //
  // badf/agents.yaml routed changes to itself to `verifier:
  // repository-administrator`, so filling that seat required the seat to
  // verify its own creation. badf/bootstrap.yaml is the record of the
  // out-of-band act that breaks the loop, and it is the ONE place where a
  // named human may legally appear in a seat - so every rule guarding it
  // gets a mutation, and the pin those rules narrow (held_by) gets the one
  // it never had.
  {
    file: RECORDS,
    suite: "validator",
    // The reader's default. Same shape as the signing-policy reader above:
    // the message is still computed and simply never reported.
    name: "records: silently skip a bootstrap-record line the reader cannot classify",
    witness: "test_a_bootstrap_line_the_reader_cannot_classify_is_reported",
    from: "        problems.append(\n            f\"badf/bootstrap.yaml line {number}: matches no rule of this record's \"",
    to: "        _unclassified_bootstrap = (\n            f\"badf/bootstrap.yaml line {number}: matches no rule of this record's \"",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: silently skip an unknown top-level key in the bootstrap record",
    witness: "test_an_unknown_top_level_key_in_the_bootstrap_record_is_reported",
    from: "                problems.append(\n                    f\"badf/bootstrap.yaml line {number}: unknown top-level key \"",
    to: "                _unknown_bootstrap_key = (\n                    f\"badf/bootstrap.yaml line {number}: unknown top-level key \"",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: silently skip an unknown field on a bootstrap seating",
    witness: "test_an_unknown_field_on_a_seating_is_reported",
    from: "                if field not in BOOTSTRAP_SEATING_FIELDS:",
    to: "                if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // BOOTSTRAP_LITERALS is one alternation for the reason ACCEPTED_KEY_RULES
    // is: each rule is one deletable line, so each can carry a control of its
    // own instead of three conditions sharing one.
    name: "records: accept a bootstrap state that is neither awaiting nor seated",
    witness: "test_a_bootstrap_state_that_is_neither_awaiting_nor_seated_is_reported",
    from: "    (\n        \"state\",\n        (BOOTSTRAP_AWAITING, BOOTSTRAP_SEATED),\n        f\"either {BOOTSTRAP_AWAITING} - the shape of a seating, awaiting the \"\n        f\"operator's name - or {BOOTSTRAP_SEATED}. A record ambiguous about \"\n        f\"whether anyone is seated is read as seated by whoever benefits\",\n    ),\n",
    to: "",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Constraint 3. Without this row the record reads as a STANDING operator
    // path rather than the spent, one-time act that adopted the succession
    // rule.
    name: "records: let the bootstrap record name a mechanism other than the operator instruction",
    witness: "test_a_bootstrap_established_by_naming_another_mechanism_is_reported",
    from: "    (\n        \"established_by\",\n        (BOOTSTRAP_ESTABLISHED_BY,),\n        f\"the literal {BOOTSTRAP_ESTABLISHED_BY}. The operator instruction is \"\n        f\"the MECHANISM that adopted the succession rule in badf/agents.yaml, \"\n        f\"and recording it as anything else turns a spent, one-time act into a \"\n        f\"second authority path a later reader may take\",\n    ),\n",
    to: "",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let the bootstrap record declare itself a standing authority path",
    witness: "test_a_bootstrap_record_declaring_itself_a_standing_path_is_reported",
    from: "    (\n        \"standing_authority_path\",\n        (\"false\",),\n        \"the literal false. This record is consumed by its own use; a record \"\n        \"that declares itself a standing path declares the bypass this \"\n        \"mechanism exists to close\",\n    ),\n",
    to: "",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The validate_lifecycle_pins treatment applied to constraint 3. A
    // sentence that can be reworded is a sentence that will be.
    name: "records: stop requiring the bootstrap establishment statement verbatim",
    witness: "test_a_reworded_establishment_statement_is_reported",
    from: "    if BOOTSTRAP_STATEMENT not in \" \".join(text.split()):",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // No markers, no digest, no immutability - and the file still reads
    // exactly as authoritative as it did with them.
    name: "records: accept a bootstrap record that delimits no frozen region",
    witness: "test_a_bootstrap_record_with_no_frozen_region_is_reported",
    from: "    if block is None:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let one bootstrap record seat the same seat twice",
    witness: "test_a_seating_naming_the_same_seat_twice_is_reported",
    from: "        if seat in seats_named:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let a bootstrap record seat an office no registry declares",
    witness: "test_a_seating_naming_no_declared_role_is_reported",
    from: "            errors.append(\n                f\"badf/bootstrap.yaml: seating {position} (line {line}) names seat \"\n                f\"{seat!r}, which is no role declared in badf/agents.yaml. A record \"",
    to: "            _undeclared_seat = (\n                f\"badf/bootstrap.yaml: seating {position} (line {line}) names seat \"\n                f\"{seat!r}, which is no role declared in badf/agents.yaml. A record \"",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The mechanism exists for human-only seats. Without this the held_by pin
    // opens for every agent-occupiable seat at once.
    name: "records: let a bootstrap record seat a seat an agent may occupy",
    witness: "test_a_seating_naming_a_seat_an_agent_may_occupy_is_reported",
    from: "            errors.append(\n                f\"badf/bootstrap.yaml: seating {position} (line {line}) names seat \"\n                f\"{seat!r}, whose may_be_an_agent is not false. This mechanism exists \"",
    to: "            _agent_occupiable_seat = (\n                f\"badf/bootstrap.yaml: seating {position} (line {line}) names seat \"\n                f\"{seat!r}, whose may_be_an_agent is not false. This mechanism exists \"",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let a bootstrap record name a principal while it still awaits the operator",
    witness: "test_a_principal_named_while_awaiting_the_operator_is_reported",
    from: "            errors.append(\n                f\"badf/bootstrap.yaml: seating {position} (line {line}) records \"\n                f\"principal {principal!r} while state is {BOOTSTRAP_AWAITING}. This \"",
    to: "            _named_while_awaiting = (\n                f\"badf/bootstrap.yaml: seating {position} (line {line}) records \"\n                f\"principal {principal!r} while state is {BOOTSTRAP_AWAITING}. This \"",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The forgery the whole record is shaped to refuse: the act declared
    // complete without an operator ever naming anyone.
    name: "records: accept a completed bootstrap seating that names no human at all",
    witness: "test_a_seating_with_no_principal_while_seated_is_reported",
    from: "            errors.append(\n                f\"badf/bootstrap.yaml: seating {position} (line {line}) records no \"\n                f\"principal while state is {BOOTSTRAP_SEATED}. A seating with no \"",
    to: "            _seated_with_nobody = (\n                f\"badf/bootstrap.yaml: seating {position} (line {line}) records no \"\n                f\"principal while state is {BOOTSTRAP_SEATED}. A seating with no \"",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let a bootstrap seating disagree with the held_by it claims to have filled",
    witness: "test_a_seated_seat_whose_held_by_is_still_null_is_reported",
    from: "        if held != principal:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The pin itself, which had no mutation until this task. NARROWING it was
    // the change; deleting it is what this proves is caught.
    name: "records: unpin held_by, so any seat may name any occupant",
    witness: "test_a_held_by_no_bootstrap_record_names_is_reported",
    from: "            if held_by != \"null\" and seated.get(role_id) != held_by:",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let one principal hold two seats with no declared exception",
    witness: "test_one_principal_in_two_seats_without_the_exception_is_reported",
    from: "    if doubled and dual != \"true\":",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The other direction of DECLARED SEPARATION = ACTUAL SEPARATION: an
    // expiring exception with nothing to except is cover, not a constraint.
    name: "records: accept a declared dual seat that no principal actually holds",
    witness: "test_a_declared_dual_seat_with_no_dual_seat_is_reported",
    from: "    if not doubled and dual == \"true\":",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let a dual seat be an exception of any type at all",
    witness: "test_a_dual_seat_whose_exception_type_is_not_bootstrap_is_reported",
    from: "    if dual == \"true\" and exception != BOOTSTRAP_EXCEPTION_TYPE:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let a dual seat record no expiry and no separation trigger",
    witness: "test_a_dual_seat_with_no_expiry_or_trigger_is_reported",
    from: "    if dual == \"true\" and (",
    to: "    if False and (",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let a dual-seat exception outlive its own expiry",
    witness: "test_a_dual_seat_exception_that_has_already_expired_is_reported",
    from: "    if BOOTSTRAP_DATE.match(expiry) is not None and expiry[:10] < now[:10]:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let the two records disagree about whether anyone is seated",
    witness: "test_a_ledger_disagreeing_about_whether_anyone_is_seated_is_reported",
    from: "    if str(ledger.get(\"state\")) != declared_state:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The fail-closed hinge. schemas/current-state.schema.json requires the
    // block too, so the run goes red either way - which is exactly why this
    // refusal needs a mutation and a control of its own, or it could be
    // deleted with the sweep still printing a full house.
    name: "records: stop reporting a state file that carries no consumption ledger",
    witness: "test_a_state_file_with_no_consumption_ledger_is_reported",
    from: "        errors.append(\n            \"badf/current-state.json: records no bootstrap block, so nothing outside \"",
    to: "        _no_ledger = (\n            \"badf/current-state.json: records no bootstrap block, so nothing outside \"",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The persistent bypass, which is constraint 1 exactly: the capability is
    // consumed by its own use or it is a standing one.
    name: "records: let a second bootstrap act be written after the first was spent",
    witness: "test_a_second_bootstrap_act_is_reported",
    from: "    if str(ledger.get(\"act_id\")) != scalars.get(\"act_id\", \"\").strip():",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let a consumed bootstrap record be reused for another seat",
    witness: "test_a_consumed_bootstrap_record_reused_for_another_seat_is_reported",
    from: "    if recorded_seats != sorted(seated):",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let a bootstrap digest be recorded before anyone is seated",
    witness: "test_a_digest_recorded_before_anyone_is_seated_is_reported",
    from: "    if declared_state == BOOTSTRAP_AWAITING and recorded is not None:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The immutability check itself. With it gone the historical record is
    // editable by whoever the record seated, which is the loop this whole
    // mechanism exists to leave closed behind it.
    name: "records: let the seated administrator rewrite the act that created its authority",
    witness: "test_an_edited_historical_record_is_reported",
    from: "        if recorded != computed:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: let the bootstrap record be reviewed by a seat it seats",
    witness: "test_routing_the_bootstrap_record_to_the_seat_it_seats_is_reported",
    from: "            if value in seats_named:",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // SUCCESSION_PINS is a table for the reason BOOTSTRAP_LITERALS is: the
    // two halves of the rule are independently deletable, so they get a
    // control and a mutation each.
    name: "records: stop pinning the first-fill half of the succession rule",
    witness: "test_deleting_the_first_fill_succession_sentence_is_reported",
    from: "    (\n        \"The first fill of a seat whose may_be_an_agent is false is verified by a \"\n        \"different seat whose may_be_an_agent is false.\",\n        \"the rule that a human-only seat's FIRST occupant is verified by a \"\n        \"DIFFERENT human-only seat, which is what keeps an agent from ever being \"\n        \"the verifier of a seating\",\n    ),\n",
    to: "",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop pinning the half of the succession rule that makes it a rule",
    witness: "test_deleting_the_subsequent_change_succession_sentence_is_reported",
    from: "    (\n        \"Every subsequent change to that seat's occupancy is verified normally by \"\n        \"the routing table above.\",\n        \"the sentence that makes this a RULE and not a standing exception: once a \"\n        \"seat is filled, its occupancy is routed like everything else, and the \"\n        \"bootstrap path is not available a second time\",\n    ),\n",
    to: "",
  },
  // ---- round two of the bootstrap review: C-1 and I-1..I-5 --------------
  //
  // The mechanism held; the region it froze did not have to enclose
  // anything, an act could be recorded as spent having seated nobody, an
  // empty scalar could swallow the seatings a human reads, and the
  // succession rule could be demoted from a key to a comment. Each of
  // those was reachable with exit 0 against an otherwise-real repository.
  {
    file: RECORDS,
    suite: "validator",
    // C-1, first half. A region present, ordered and enclosing NOTHING hashed
    // the empty string and passed, with every historical field outside it.
    // The marker mutation above deletes the END line, which is a different
    // thing from a region that is present and covers zero bytes.
    name: "records: accept a frozen historical region that encloses nothing",
    witness: "test_a_frozen_region_that_encloses_nothing_is_reported",
    from: "    if block is not None and block.strip() == \"\":",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // C-1, second half, and the sharper one. With END moved so the region
    // held only act_id, the principal could be rewritten in
    // badf/bootstrap.yaml AND badf/agents.yaml with the ledger untouched and
    // the recorded digest still matching - one forger, one pair of files.
    name: "records: let a recorded field sit outside the region its digest covers",
    witness: "test_a_field_recorded_outside_the_frozen_region_is_reported",
    from: "            if what in (\"version\", \"updated_at\") or span[0] < number < span[1]:",
    to: "            if True:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The mirror of the declared dual seat nobody holds: the single-use
    // capability recorded as spent having seated nobody at all.
    name: "records: accept a completed bootstrap act that seats nobody",
    witness: "test_a_completed_act_that_seats_nobody_is_reported",
    from: "    if declared_state == BOOTSTRAP_SEATED and not seatings:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // An empty value opened a folded block, and a block opened by accident
    // swallows every line indented under it WITHOUT classifying any - which
    // this reader's docstring promises never to do. It is how a record that
    // reads to a human as a completed seating parses as no seating at all.
    name: "records: let an empty bootstrap scalar open a block and swallow the seatings",
    witness: "test_a_top_level_scalar_with_no_value_is_reported",
    from: "                    elif value == \"\":",
    to: "                    elif False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Only a PAST expiry was checked, so a future date with no dual seat sat
    // in the record reading as a live exception no rule above governs.
    name: "records: let a bootstrap record carry dual-seat fields with no dual seat",
    witness: "test_dual_seat_fields_recorded_with_no_dual_seat_are_reported",
    from: "    if dual != \"true\" and (",
    to: "    if False and (",
  },
  {
    file: RECORDS,
    suite: "validator",
    // The static PINNED_ROUTING entry for this path is gone, so 'routed at
    // all' is this rule's to state. A path with no row routes to
    // peer-reviewer, a seat an agent may occupy.
    name: "records: let the bootstrap record be routed nowhere at all",
    witness: "test_deleting_the_bootstrap_routing_entry_is_reported",
    from: "    if not routes:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Not the seat the record seats - just a seat an agent may hold. Without
    // this an agent reviews the creation of authority.
    name: "records: let a seat an agent may occupy review the bootstrap record",
    witness: "test_routing_the_bootstrap_record_to_an_agent_occupiable_seat_is_reported",
    from: "            if roles.get(value, {}).get(\"may_be_an_agent\", \"\").strip().strip('\"') != \"false\":",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Constraint 5 was a byte-substring pin over the whole file, so deleting
    // the succession: key and leaving both sentences as ordinary comments
    // passed. A rule nothing parses is not a rule of the file.
    name: "records: accept a succession rule demoted from a key to a comment",
    witness: "test_demoting_the_succession_rule_to_comments_is_reported",
    from: "    if opener is None:\n        errors.append(\n            \"badf/agents.yaml: declares no top-level succession: key. The rule that \"",
    to: "    if opener is None:\n        _no_succession_key = (\n            \"badf/agents.yaml: declares no top-level succession: key. The rule that \"",
  },
  {
    file: CODEOWNERS,
    // The occupancy sentence in the generated header was UNCONDITIONAL, so
    // the moment a human is seated the file would assert in writing that
    // nobody holds any seat, and nothing read held_by here to notice.
    name: "codeowners: assert that no seat is occupied whatever the registry records",
    witness: "the header's occupancy claim is derived from held_by, not asserted",
    from: "    (role) => (role.held_by ?? \"null\").replace(/\"/g, \"\").trim() !== \"null\",",
    to: "    () => false,",
  },
  {
    file: SIGNING_POLICY,
    name: "signing: read a policy line the second reader cannot classify as if it were fine",
    witness: "a line the signing policy grammar does not classify is refused with its number",
    from: "    throw unclassified(lineNo, raw);",
    to: "    continue;",
  },
  {
    file: SIGNING_POLICY,
    name: "signing: accept a policy value git would read as an option rather than a path",
    witness: "a value the policy hands to git that is not the shape it must be is refused",
    from: '  if (!pattern.test(value) || value.split("/").includes("..")) {',
    to: "  if (false) {",
  },
  {
    file: SIGNING_CHECK,
    // git answers %G? with eight codes. Four of them contain the word "good"
    // and one of those is a signature made by a REVOKED key.
    name: "signing: read any %G? code as a verified signature, not only G",
    witness: "only a %G? of G is read as a verified signature",
    from: "  if (record.code !== GOOD_SIGNATURE) {",
    to: "  if (false) {",
  },
  {
    file: SIGNING_CHECK,
    name: "signing: accept a good signature from an identity the policy never enrolled",
    witness: "a good signature by an identity the policy does not accept is not verified",
    from: "  if (!named.some((value) => acceptedIdentities.includes(value))) {",
    to: "  if (false) {",
  },
  {
    file: SIGNING_CHECK,
    // The honesty branch. Without it the check reports an ordinary FAIL for a
    // state no agent can remedy - or, one edit further, nothing at all.
    name: "signing: stop announcing NOT_ENFORCED when the policy enrols no key",
    witness: "the signing check reports NOT_ENFORCED, and never PASS, while no key is enrolled",
    from: "  if (accepted.length === 0) {",
    to: "  if (false) {",
  },
  // ---- the git plumbing, which the first version of this task left
  // ---- unwitnessed and a review then broke six ways ------------------------
  //
  // Every one below names `suite: "signing"`: tests/signing/enforcement.test.mjs
  // builds real repositories and takes ~4.5s, so running it for each of the
  // hundred-odd boundary mutations would add minutes to `pnpm verify` for
  // controls none of them can move. Same reasoning, and the same shape, as the
  // `validator` suite above.
  //
  // The first is the CRITICAL one. A shallow clone grafts its root, every file
  // reads as ADDED there, `--diff-filter=A` returns exactly one sha - HEAD -
  // and the check reported PASS having verified nothing. Before this control
  // the only thing refusing that was `fetch-depth: 0` in one CI file, which no
  // test named: deleting that line made nothing go red.
  {
    file: SIGNING_CHECK,
    suite: "signing",
    name: "signing: let a shallow clone anchor the enforcement point at its own root",
    witness: "a shallow clone is refused, not silently anchored at its own grafted root",
    from: '  if (git(["rev-parse", "--is-shallow-repository"]).trim() === "true") {',
    to: "  if (false) {",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    // The same bypass without the shallow flag, and the one the guard above
    // cannot see: `git replace --graft HEAD` gives a repository git calls
    // NOT shallow, with one commit, whose every file reads as added in HEAD.
    // Dropping the flag hands the check back to refs/replace.
    name: "signing: let refs/replace rewrite the history this check reads",
    witness: "a grafted history is read through to the real commits, not the replacement",
    from: "  const argv = [NO_REPLACEMENT, ...args];",
    to: "  const argv = [...args];",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    // DEC-029's sibling vector: --no-replace-objects does not touch
    // .git/info/grafts, git's older graft mechanism. Dropping the
    // GIT_GRAFT_FILE override hands the check back to whatever an agent with
    // ordinary .git/ write access - strictly less than `git replace` needs -
    // has written into that file.
    name: "signing: let .git/info/grafts rewrite the history this check reads",
    witness: "a graft written straight into .git/info/grafts is read through to the real commits, not the replacement",
    from: "      env: { ...process.env, GIT_GRAFT_FILE: NO_GRAFTS },",
    to: "      env: { ...process.env },",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    name: "signing: resolve an enforcement point no commit in the history establishes",
    witness: "a policy no commit has added is refused rather than resolved to something",
    from: "  if (adds.length === 0) {",
    to: "  if (false) {",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    // The anti-forgery refusal: without it an agent moves the enforcement
    // point past its own forgery by deleting the policy and restoring it.
    name: "signing: resolve an ambiguous enforcement point to the most recent add",
    witness: "an enforcement point two commits both claim is refused as ambiguous",
    from: "  if (adds.length > 1) {",
    to: "  if (false) {",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    // Exclusive, and it has to be: the commit that ADDS the policy is the one
    // commit that could not have been signed under it.
    name: "signing: govern the commit that introduced the policy, retroactively",
    witness: "the enforcement point is exclusive: the commit that added the policy is not governed",
    from: "      `${point}..HEAD`,",
    to: "      `${point}^..HEAD`,",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    name: "signing: drop a git log record this check cannot parse instead of refusing it",
    witness: "a git log record this check cannot parse is refused, never dropped",
    from: "    if (fields.length !== 4) {",
    to: "    if (false) {",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    // "I could not ask git" and "the answer was fine" are different sentences.
    // Throwing a plain Error makes main() rethrow it as a check defect rather
    // than report which question went unasked.
    name: "signing: report a failed git command as something other than an unasked question",
    witness: "a git command that fails is reported as a check that could not run",
    from: lines(
      "    throw new GitUnavailable(",
      '      `git ${argv.join(" ")} failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`,',
    ),
    to: lines(
      "    throw new Error(",
      '      `git ${argv.join(" ")} failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`,',
    ),
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    name: "signing: stop reporting an unreadable policy as a failure of the check",
    witness: "a policy the reader cannot read fails the check rather than passing it",
    from: '    if (error instanceof SigningPolicyError || error?.code === "ENOENT") {',
    to: "    if (false) {",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    // The branch the whole check exists for. Without it an unverified governed
    // commit is reported on the UNVERIFIED lines and then the run prints PASS.
    name: "signing: print PASS even when a governed commit is unverified",
    witness: "an unsigned commit touching a protected path fails once an identity is enrolled",
    from: "  if (unverified.length > 0) {",
    to: "  if (false) {",
  },
  {
    file: PACKAGE,
    // The composition scripts/signing-policy.mjs's docstring depends on, and
    // which nothing guarded until the final review of this branch said so.
    // That reader hands check-signing.mjs a self-enrolled identity the Python
    // validator refuses; running the check FIRST is therefore a real
    // loosening, and it used to turn nothing red.
    name: "verify: run the signature check before the record validator its inputs depend on",
    witness: "pnpm verify runs the signing check, and runs the record validator before it",
    from: "pnpm validate:records && pnpm test:validator && pnpm check:signing",
    to: "pnpm check:signing && pnpm validate:records && pnpm test:validator",
  },

  // ---- review fixes for BIZTRUST-WP-001, issue #8: validator hardening ------
  {
    file: RECORDS,
    suite: "validator",
    // M1, first half. Without it a forbidden power can be deleted from
    // may_not, in one file, and the registry still passes.
    name: "records: stop requiring every pinned forbidden tool power to stay in may_not",
    witness: "test_a_pinned_tool_power_missing_from_may_not_is_reported",
    from: "        if _normalised(pinned) not in forbidden:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // M1, second half. Without it a forbidden power is granted by listing it
    // under may while it is still (falsely) recorded as forbidden.
    name: "records: stop refusing a pinned forbidden tool power listed under may",
    witness: "test_a_pinned_tool_power_listed_under_may_is_reported",
    from: "        if _normalised(pinned) in permitted:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Round seven N1, double quotes. A quoted item that json.loads cannot read
    // whole (a trailing comment, text after the closing quote) used to fall
    // back to the text between the outer quotes, which no longer matched its
    // pin while PyYAML read exactly the pinned string.
    name: "records: read a double-quoted tool power it cannot decode instead of refusing it",
    witness: "test_a_tool_power_item_with_a_comment_under_may_not_is_refused_too",
    from: "        if not isinstance(decoded, str):",
    to: lines(
      "        if not isinstance(decoded, str):",
      "            return body[1:-1], None",
      "        if False:",
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    // Round seven N1, single quotes.
    name: "records: read a single-quoted tool power with text outside its quotes",
    witness: "test_a_tool_power_item_with_a_trailing_comment_is_refused_not_skipped",
    from: "        if _SINGLE_QUOTED_SCALAR.match(body) is None:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Round seven N1, plain scalars: ` # comment`, flow brackets, anchors.
    name: "records: read a plain tool power item without checking it is one plain scalar",
    witness: "test_a_tool_power_item_that_is_not_a_scalar_is_refused",
    from: "    if _PLAIN_SCALAR.match(body) is None:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Round seven N1, the second block. Merged rather than refused, so a
    // `tool_authority:` appended to the file replaced the lists for PyYAML only.
    name: "records: merge a second top-level block instead of refusing the duplicate key",
    witness: "test_a_second_tool_authority_block_is_reported",
    from: "            if section in seen_sections:",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Round seven N1, the same bypass one level down: two `may_not:` lists.
    name: "records: merge a second list of the same name inside tool_authority",
    witness: "test_a_second_list_of_the_same_name_inside_tool_authority_is_reported",
    from: "            if current in opened:",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // M2. The only rule between a P0 grant written into authority.yaml alone
    // and a passing validate:records. Deleting it turned nothing red.
    name: "records: stop refusing a registry grant the state file still reads as withheld",
    witness: "test_a_registry_grant_the_state_file_still_reads_as_withheld_is_reported",
    from: "        if in_granted and withheld:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // M3, the act. A NEW act (BOOTSTRAP-002) recorded consistently in the
    // record and the ledger is a second bootstrap; only the pin refuses it.
    name: "records: stop pinning BOOTSTRAP-001 as the only bootstrap act",
    witness: "test_a_second_bootstrap_act_is_reported_even_when_the_ledger_agrees",
    from: '    if scalars.get("act_id", "").strip() != BOOTSTRAP_PINNED_ACT:',
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // M3, the state. Reverting the spent act to AWAITING un-spends it.
    name: "records: stop pinning the spent bootstrap act as SEATED",
    witness: "test_reverting_the_spent_act_to_awaiting_is_reported_even_when_the_ledger_agrees",
    from: "    if declared_state != BOOTSTRAP_PINNED_STATE:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // M3, the seats. A second seating in the spent act, ledger edited to match.
    name: "records: stop pinning the seats the spent bootstrap act seated",
    witness: "test_a_second_seating_by_the_spent_act_is_reported_even_when_the_ledger_agrees",
    from: "        if sorted(seats_named) != sorted(BOOTSTRAP_PINNED_SEATS):",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // M3, the text. A rewritten frozen region with the ledger digest repaired.
    name: "records: stop pinning the digest of the spent bootstrap act's frozen record",
    witness: "test_a_rewritten_historical_record_is_reported_even_when_the_ledger_digest_is_repaired",
    from: "        if pinned_computed != BOOTSTRAP_PINNED_DIGEST:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // M4, the key. GitHub's web-flow key signs every squash merge on main;
    // enrolling it would make the check pass changes no human signed.
    name: "records: stop refusing GitHub's web-flow key as an accepted signing key",
    witness: "test_enrolling_githubs_web_flow_key_is_reported",
    from: "        if WEB_FLOW_KEY_ID.casefold() in identity:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // M4, the committer. git reports the signer and the key separately, so a
    // policy can name either; each refusal has a control of its own.
    name: "records: stop refusing GitHub's web-flow committer identity as an accepted signer",
    witness: "test_enrolling_githubs_web_flow_committer_identity_is_reported",
    from: "        if WEB_FLOW_COMMITTER_EMAIL in identity:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // M5. The instrument paths, dropped from the floor the validator pins. The
    // narrower witness than the existing floor mutation: it is killed by the
    // instrument-path test alone, where dropping the whole floor also kills
    // the older badf/authority.yaml one.
    name: "records: stop pinning the signing instrument and its inputs as protected paths",
    witness: "test_dropping_a_pinned_instrument_path_is_reported",
    from: lines(
      '    "scripts/check-signing.mjs",',
      '    "scripts/signing-policy.mjs",',
      '    "scripts/validate_continuity.py",',
      '    "schemas",',
      '    "package.json",',
      '    ".github",',
    ),
    to: "    # (the instrument paths are no longer pinned)",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Round seven N2. The launcher, the tests that witness the validator and
    // the signing check, the sweep, and the two records an agent writes.
    name: "records: stop pinning the launcher, the witnesses and two agent-written records",
    witness: "test_dropping_a_pinned_launcher_or_witness_path_is_reported",
    from: lines(
      '    "scripts/python.mjs",',
      '    "scripts/mutation-check.mjs",',
      '    "tests/unit",',
      '    "tests/signing",',
      '    "badf/decision-log.jsonl",',
      '    "badf/next-actions.json",',
    ),
    to: "    # (the launcher and witness paths are no longer pinned)",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    // Round seven N2, the refusal itself. Without it the check takes its
    // protected set from the policy under judgement and prints PASS over
    // commits it would fail on with the list intact.
    name: "signing: take the protected set from the policy under judgement, with no floor",
    witness: "a policy that shortens its own protected set is refused, not read as the set to check",
    from: "  if (omitted.length > 0) {",
    to: "  if (false) {",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    // The comparison inside the floor: report nothing as missing.
    name: "signing: report no floor path as missing from a policy",
    witness: "a protected set missing any one floor path is reported as missing exactly that path",
    from: "  return PROTECTED_PATH_FLOOR.filter((path) => !held.has(path));",
    to: "  return PROTECTED_PATH_FLOOR.filter((path) => false);",
  },
  {
    file: SIGNING_CHECK,
    suite: "signing",
    // The floor's own contents: one entry lost from the list is a path a
    // shortened policy may drop unreported.
    name: "signing: drop tests/signing from the floor the check holds",
    witness: "the floor this check holds is exactly the floor recorded in this test",
    from: lines('  "tests/signing",', '  "badf/decision-log.jsonl",'),
    to: '  "badf/decision-log.jsonl",',
  },
  {
    file: RECORDS,
    suite: "validator",
    // M5, the shape. Allowing a bare dot would make `.` a protected path: a
    // pathspec for the whole tree, which git reads as everything.
    name: "records: accept a bare dot as a plain protected path",
    witness: "test_a_protected_path_that_is_only_a_dot_is_reported",
    from: 'PROTECTED_PATH = re.compile(r"^\\.?[A-Za-z0-9_][A-Za-z0-9._/-]*$")',
    to: 'PROTECTED_PATH = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9._/-]*$")',
  },
  {
    file: RECORDS,
    suite: "validator",
    // M5, the other direction. `.github` could not be spelled, so the workflow
    // that runs the check could not be a protected path.
    name: "records: refuse a protected path that begins with a dot",
    witness: "test_a_dot_directory_is_a_plain_protected_path",
    from: 'PROTECTED_PATH = re.compile(r"^\\.?[A-Za-z0-9_][A-Za-z0-9._/-]*$")',
    to: 'PROTECTED_PATH = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._/-]*$")',
  },
  {
    file: SIGNING_POLICY,
    // M5, the second reader. The shape must agree with the Python one, or the
    // two readers disagree about which paths are protected.
    name: "signing: refuse a protected path that begins with a dot in the second reader",
    witness: "the policy protects the signing instrument and what it stands on",
    from: "const PLAIN_PATH = /^\\.?[A-Za-z0-9_][A-Za-z0-9._/-]*$/;",
    to: "const PLAIN_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;",
  },
  {
    file: SIGNING_POLICY,
    name: "signing: accept a bare dot as a plain protected path in the second reader",
    witness: "a protected path may begin with one dot when a name follows it, and is never only a dot",
    from: "const PLAIN_PATH = /^\\.?[A-Za-z0-9_][A-Za-z0-9._/-]*$/;",
    to: "const PLAIN_PATH = /^[A-Za-z0-9_.][A-Za-z0-9._/-]*$/;",
  },
  // Review finding m5: credential shapes the scan for secrets in the tree
  // missed. One mutation per shape, each rewriting only that shape's regex.
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop scanning the tree for GitHub server and user tokens",
    witness: "test_a_github_server_or_user_token_in_the_tree_is_reported",
    from: 're.compile(r"gh[su]_[A-Za-z0-9]{20,}")',
    to: 're.compile(r"NEVERMATCHES")',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop scanning the tree for Stripe live keys",
    witness: "test_a_stripe_live_key_in_the_tree_is_reported",
    from: 're.compile(r"sk_live_[A-Za-z0-9]{20,}")',
    to: 're.compile(r"NEVERMATCHES")',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop scanning the tree for Google API keys",
    witness: "test_a_google_api_key_in_the_tree_is_reported",
    from: 're.compile(r"AIza[0-9A-Za-z_-]{35}")',
    to: 're.compile(r"NEVERMATCHES")',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop scanning the tree for npm access tokens",
    witness: "test_an_npm_token_in_the_tree_is_reported",
    from: 're.compile(r"npm_[A-Za-z0-9]{30,}")',
    to: 're.compile(r"NEVERMATCHES")',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop scanning the tree for GitHub refresh tokens",
    witness: "test_a_github_refresh_token_in_the_tree_is_reported",
    from: 're.compile(r"ghr_[A-Za-z0-9]{20,}")',
    to: 're.compile(r"NEVERMATCHES")',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop scanning the tree for Stripe restricted keys",
    witness: "test_a_stripe_restricted_key_in_the_tree_is_reported",
    from: 're.compile(r"rk_live_[A-Za-z0-9]{20,}")',
    to: 're.compile(r"NEVERMATCHES")',
  },
  {
    file: RECORDS,
    suite: "validator",
    // Round seven m1. The whole validator file used to be skipped by the scan,
    // and it is the file that carries every pin. The mutation puts the
    // exemption back.
    name: "records: exempt the validator file itself from the credential scan",
    witness: "test_a_credential_planted_in_the_validator_itself_is_reported",
    from: lines(
      "        if (",
      '            any(segment in relative.split("/") for segment in skip_segments)',
    ),
    to: lines(
      '        if relative == "scripts/validate_continuity.py":',
      "            continue",
      "        if (",
      '            any(segment in relative.split("/") for segment in skip_segments)',
    ),
  },
  // ---- round ten, S-1: a hand reader reads the file YAML reads ------------
  //
  // Every value that opens a quote is exactly one complete quoted scalar on
  // its line, and no field, entry or top-level key is read twice. One
  // mutation per call site, each with a test that breaks exactly that shape.
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read an authority field whose quote never closes (R10-S1)",
    witness: "test_an_authority_field_that_opens_a_quote_it_does_not_close_is_refused",
    from: '            if refuse_value("badf/authority.yaml", number, field, value, problems):',
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read an authority top-level value whose quote never closes (R10-S1)",
    witness: "test_an_authority_top_level_value_that_opens_a_quote_is_refused",
    from: '            refuse_value("badf/authority.yaml", number, section, rest, problems)',
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal fields in an authority entry (R10-S1)",
    witness: "test_a_repeated_field_in_an_authority_entry_is_refused",
    from: lines(
      "            if refuse_repeat(",
      '                "badf/authority.yaml", number, field, f"{section}.{key}",',
    ),
    to: lines(
      "            if False and refuse_repeat(",
      '                "badf/authority.yaml", number, field, f"{section}.{key}",',
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: merge two equal entries in an authority section (R10-S1)",
    witness: "test_a_repeated_entry_in_an_authority_section_is_refused",
    from: lines(
      "            refuse_repeat(",
      '                "badf/authority.yaml", number, key, section, sections[section], problems',
      "            )",
    ),
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a skills field whose quote never closes (R10-S1)",
    witness: "test_a_skills_field_that_opens_a_quote_it_does_not_close_is_refused",
    from: '            if refuse_value("badf/skills.yaml", number, field, value, problems):',
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a skill id whose quote never closes (R10-S1)",
    witness: "test_a_skills_id_that_opens_a_quote_is_refused",
    from: '            refuse_value("badf/skills.yaml", number, "id", current, problems)',
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a skills top-level value whose quote never closes (R10-S1)",
    witness: "test_a_skills_top_level_value_that_opens_a_quote_is_refused",
    from: '            refuse_value("badf/skills.yaml", number, key, rest, problems)',
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal top-level keys in skills (R10-S1)",
    witness: "test_a_repeated_top_level_section_in_skills_is_refused",
    from: '            refuse_repeat("badf/skills.yaml", number, key, "this file", seen_top, problems)',
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal fields in a skill entry (R10-S1)",
    witness: "test_a_repeated_field_in_a_skill_entry_is_refused",
    from: lines(
      "            if refuse_repeat(",
      '                "badf/skills.yaml", number, field, f"skill {current!r}",',
    ),
    to: lines(
      "            if False and refuse_repeat(",
      '                "badf/skills.yaml", number, field, f"skill {current!r}",',
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a role or routing field whose quote never closes (R10-S1)",
    witness: "test_a_role_field_that_opens_a_quote_it_does_not_close_is_refused",
    from: '            if refuse_value("badf/agents.yaml", number, field, value, problems):',
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read an agents top-level value whose quote never closes (R10-S1)",
    witness: "test_an_agents_top_level_value_that_opens_a_quote_is_refused",
    from: '            refuse_value("badf/agents.yaml", number, key, rest, problems)',
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal top-level keys in agents (R10-S1)",
    witness: "test_a_repeated_top_level_section_in_agents_is_refused",
    from: '            refuse_repeat("badf/agents.yaml", number, key, "this file", seen_top, problems)',
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a role id whose quote never closes (R10-S1)",
    witness: "test_a_role_id_that_opens_a_quote_is_refused",
    from: '                refuse_value("badf/agents.yaml", number, "id", current_role, problems)',
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a routing path whose quote never closes (R10-S1)",
    witness: "test_a_routing_path_that_opens_a_quote_is_refused",
    from: lines(
      "                refuse_value(",
      '                    "badf/agents.yaml", number, "path", current_route["path"], problems',
      "                )",
    ),
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal fields in a role (R10-S1)",
    witness: "test_a_repeated_field_in_a_role_is_refused",
    from: lines(
      "                if refuse_repeat(",
      '                    "badf/agents.yaml", number, field, f"role {current_role!r}",',
    ),
    to: lines(
      "                if False and refuse_repeat(",
      '                    "badf/agents.yaml", number, field, f"role {current_role!r}",',
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal fields in a routing entry (R10-S1)",
    witness: "test_a_repeated_field_in_a_routing_entry_is_refused",
    from: "                    current_route, problems,",
    to: "                    {}, problems,",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a bootstrap scalar whose quote never closes (R10-S1)",
    witness: "test_a_bootstrap_scalar_that_opens_a_quote_is_refused",
    from: '                refuse_value("badf/bootstrap.yaml", number, key, value, problems)',
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal top-level keys in the bootstrap record (R10-S1)",
    witness: "test_a_repeated_scalar_in_the_bootstrap_record_is_refused",
    from: lines(
      "                refuse_repeat(",
      '                    "badf/bootstrap.yaml", number, key, "this file", seen_top, problems',
      "                )",
    ),
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a bootstrap seat whose quote never closes (R10-S1)",
    witness: "test_a_bootstrap_seat_that_opens_a_quote_is_refused",
    from: lines(
      "                refuse_value(",
      '                    "badf/bootstrap.yaml", number, "seat", opener.group(1).strip(), problems',
      "                )",
    ),
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a bootstrap seating field whose quote never closes (R10-S1)",
    witness: "test_a_bootstrap_seating_field_that_opens_a_quote_is_refused",
    from: '                if refuse_value("badf/bootstrap.yaml", number, field, value, problems):',
    to: "                if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal fields in a bootstrap seating (R10-S1)",
    witness: "test_a_repeated_field_in_a_bootstrap_seating_is_refused",
    from: lines(
      "                if refuse_repeat(",
      '                    "badf/bootstrap.yaml", number, field,',
    ),
    to: lines(
      "                if False and refuse_repeat(",
      '                    "badf/bootstrap.yaml", number, field,',
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a signing-policy top-level value whose quote never closes (R10-S1)",
    witness: "test_a_signing_policy_scalar_that_opens_a_quote_is_refused",
    from: '                refuse_value("badf/signing-policy.yaml", number, key, value, problems)',
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal top-level keys in the signing policy (R10-S1)",
    witness: "test_a_repeated_scalar_in_the_signing_policy_is_refused",
    from: lines(
      "                refuse_repeat(",
      '                    "badf/signing-policy.yaml", number, key, "this file", seen_top, problems',
      "                )",
    ),
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a signing-policy protected path whose quote never closes (R10-S1)",
    witness: "test_a_signing_policy_path_that_opens_a_quote_is_refused",
    from: lines(
      "                refuse_value(",
      '                    "badf/signing-policy.yaml", number, "protected_paths item",',
      "                    item.group(1), problems,",
      "                )",
    ),
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a signing-policy key identity whose quote never closes (R10-S1)",
    witness: "test_a_signing_policy_key_identity_that_opens_a_quote_is_refused",
    from: lines(
      "                refuse_value(",
      '                    "badf/signing-policy.yaml", number, "identity",',
      "                    opener.group(1).strip(), problems,",
      "                )",
    ),
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a signing-policy key field whose quote never closes (R10-S1)",
    witness: "test_a_signing_policy_key_field_that_opens_a_quote_is_refused",
    from: '                if refuse_value("badf/signing-policy.yaml", number, field, value, problems):',
    to: "                if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal fields in a signing-policy key (R10-S1)",
    witness: "test_a_repeated_field_in_a_signing_policy_key_is_refused",
    from: lines(
      "                if refuse_repeat(",
      '                    "badf/signing-policy.yaml", number, field,',
    ),
    to: lines(
      "                if False and refuse_repeat(",
      '                    "badf/signing-policy.yaml", number, field,',
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a double-quoted value with text after its closing quote (R10-S1)",
    witness: "test_a_double_quoted_scalar_with_text_after_its_closing_quote_is_not_read_whole",
    from: "        if _DOUBLE_QUOTED_SCALAR.match(value) is None:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a single-quoted value with text after its closing quote (R10-S1)",
    witness: "test_a_single_quoted_scalar_with_text_after_its_closing_quote_is_not_read_whole",
    from: "        if _SINGLE_QUOTED_SCALAR.match(value) is None:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a flow collection that holds an unclosed quote (R10-S1)",
    witness: "test_a_flow_collection_holding_an_unclosed_quote_is_not_read_whole",
    from: "        if _open_quote_in_flow(value):",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a flow collection that does not close on its line (R10-S1)",
    witness: "test_a_flow_collection_that_does_not_close_on_its_line_is_not_read_whole",
    from: '        if not value.endswith("]" if value.startswith("[") else "}"):',
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a value that starts with an anchor, alias or tag (R10-S1)",
    witness: "test_an_anchor_an_alias_and_a_tag_are_not_read",
    from: '    if value.startswith(("&", "*", "!")):',
    to: "    if False:",
  },
  // ---- round ten, R9-C1 and R9-C2: the checker options the generator writes ----
  //
  // tests/boundaries/production-options.test.mjs cruises a copy of the
  // workspace with the options the generator writes, byte for byte, and plants
  // one violation per option that could hide it. Each mutation below loosens
  // exactly one of them, and each has a plant of its own.
  {
    file: GENERATOR,
    name: "generator: judge no edge into build output or the fixture tree again (R9-C1)",
    witness:
      "production options: a service importing the fixture tree is reported as " +
      "rule-6-test-packages-stay-in-tests",
    from: '      doNotFollow: { path: DO_NOT_FOLLOW },',
    to: lines(
      '      doNotFollow: { path: "node_modules" },',
      '      exclude: { path: "(^|/)dist/|^tests/boundaries/fixtures/" },',
    ),
  },
  {
    file: GENERATOR,
    name: "generator: exclude every internal directory from the checker (R9-C2)",
    witness:
      "production options: a js file importing modules/tenancy/src/internal is reported as " +
      "rule-1-internals-private-tenancy",
    from: '      doNotFollow: { path: DO_NOT_FOLLOW },',
    to: lines(
      '      doNotFollow: { path: DO_NOT_FOLLOW },',
      '      exclude: { path: "/internal/" },',
    ),
  },
  {
    file: GENERATOR,
    name: "generator: do not follow the imports of services (R9-C2)",
    witness:
      "production options: an import of @biztrust/audit/dist/internal by name is reported as " +
      "rule-1-internals-private-by-name-audit",
    from: '      doNotFollow: { path: DO_NOT_FOLLOW },',
    to: '      doNotFollow: { path: DO_NOT_FOLLOW + "|^services/" },',
  },
  {
    file: GENERATOR,
    name: "generator: stop counting type-only imports (R9-C2)",
    witness:
      "production options: a type-only import of src/internal is reported as " +
      "rule-1-internals-private-tenancy",
    from: "      tsPreCompilationDeps: true,",
    to: "      tsPreCompilationDeps: false,",
  },
  {
    file: GENERATOR,
    name: "generator: stop reading the tsconfig path map (R9-C2)",
    witness:
      "production options: a package importing a module by its bare name is reported as " +
      "rule-4-packages-import-no-module",
    from: '      tsConfig: { fileName: "tsconfig.json" },',
    to: "",
  },
  {
    file: GENERATOR,
    name: "generator: stop resolving .ts files (R9-C2)",
    witness:
      "production options: an import of src/internal spelled with no extension is reported as " +
      "rule-1-internals-private-tenancy",
    from: '        extensions: [".ts", ".js", ".mjs", ".cjs"],',
    to: '        extensions: [".js", ".mjs", ".cjs"],',
  },
  {
    file: RULES,
    name: "rule 1: stop protecting a built internal directory (R9-C1)",
    witness:
      "production options: a relative import of modules/tenancy/dist/internal is reported as " +
      "rule-1-internals-private-tenancy",
    from: "      to: { path: " + BT + "^modules/" + DOLLAR + "{rx(m.name)}/(?:src|dist)/internal/" + BT + " },",
    to: "      to: { path: " + BT + "^modules/" + DOLLAR + "{rx(m.name)}/src/internal/" + BT + " },",
  },
  {
    file: RULES,
    name: "rule 2: allow a module to import another module's built files (R9-C1)",
    witness:
      "production options: a module importing another module's dist is reported as " +
      "rule-2-contracts-only-identity-access",
    from: '        path: "^modules/(?!" + rx(m.name) + "/)[^/]+/(?:src|dist)/",',
    to: '        path: "^modules/(?!" + rx(m.name) + "/)[^/]+/src/",',
  },
  {
    file: RULES,
    name: "rule 5: allow an entry point to import a module's built files (R9-C1)",
    witness:
      "production options: a relative import of modules/tenancy/dist/internal is reported as " +
      "rule-5-entry-points-see-contracts-only",
    from: '      path: "^modules/[^/]+/(?:src|dist)/",',
    to: '      path: "^modules/[^/]+/src/",',
  },
  // ---- round eleven, C10-1 and C10-2: doNotFollow, anchored, and witnessed per source root ----
  //
  // Round ten's plants all sat in services/api/src, packages/ and one module's
  // public directory, so widening doNotFollow to any OTHER source directory
  // turned nothing red and no mutation loosened it. One mutation per root
  // below, each with a plant of its own in tests/boundaries/production-options.test.mjs.
  {
    file: RULES,
    name: "options: do not follow what a path merely CONTAINING node_modules imports (C10-1)",
    witness:
      "production options: a file whose name contains node_modules is followed, and its " +
      "import of tests is reported as rule-6-test-packages-stay-in-tests",
    from: '  thirdParty: "^node_modules/",',
    to: '  thirdParty: "node_modules",',
  },
  {
    file: RULES,
    name: "options: do not follow a first-party directory named node_modules at any depth (C10-1)",
    witness:
      "production options: a first-party directory named node_modules is followed, and its " +
      "import of internals is reported as rule-1-internals-private-tenancy",
    from: '  linkFarm: "^" + ROOTS + "/[^/]+/node_modules/",',
    to: '  linkFarm: "(^|/)node_modules/",',
  },
  {
    file: RULES,
    name: "options: do not follow a directory named dist at any depth (C10-1)",
    witness:
      "production options: a directory named dist below a source directory is followed, and " +
      "its import of internals is reported as rule-5-entry-points-see-contracts-only",
    from: '  buildOutput: "^" + ROOTS + "/[^/]+/dist/",',
    to: '  buildOutput: "(^|/)dist/",',
  },
  {
    file: RULES,
    name: "options: do not follow the imports of a module's internal directory (C10-2)",
    witness:
      "production options: a module's internal file importing another module's internals is " +
      "reported as rule-1-internals-private-audit",
    from: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|");',
    to: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|") + "|/internal/";',
  },
  {
    file: RULES,
    name: "options: do not follow the imports of apps (C10-2)",
    witness:
      "production options: an app file importing a module's internals is reported as " +
      "rule-7-control-plane-sees-packages-only",
    from: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|");',
    to: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|") + "|^apps/";',
  },
  {
    file: RULES,
    name: "options: do not follow the imports of tests (C10-2)",
    witness:
      "production options: a file under tests importing a module's internals is reported as " +
      "rule-1-internals-private-tenancy",
    from: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|");',
    to: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|") + "|^tests/";',
  },
  {
    file: RULES,
    name: "options: do not follow the imports of packages (C10-2)",
    witness:
      "production options: a package file importing a module's internals is reported as " +
      "rule-4-packages-import-no-module",
    from: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|");',
    to: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|") + "|^packages/";',
  },
  {
    file: RULES,
    name: "options: do not follow the imports of modules (C10-2)",
    witness:
      "production options: a module's public file importing another module's internals is " +
      "reported as rule-2-contracts-only-identity-access",
    from: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|");',
    to: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|") + "|^modules/";',
  },
  {
    file: GENERATOR,
    name: "generator: exclude apps from the checker (C10-2)",
    witness:
      "production options: a package importing an app is reported as " +
      "rule-5-nothing-imports-an-entry-point",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: lines(
      "      doNotFollow: { path: DO_NOT_FOLLOW },",
      '      exclude: { path: "^apps/" },',
    ),
  },
  {
    file: GENERATOR,
    name: "generator: exclude services from the checker (C10-2)",
    witness:
      "production options: a package importing a service is reported as " +
      "rule-5-nothing-imports-an-entry-point",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: lines(
      "      doNotFollow: { path: DO_NOT_FOLLOW },",
      '      exclude: { path: "^services/" },',
    ),
  },
  {
    file: GENERATOR,
    name: "generator: exclude tests from the checker (C10-2)",
    witness:
      "production options: a file under tests importing a module's internals is reported as " +
      "rule-1-internals-private-tenancy",
    shared:
      "exclude removes an import of tests/ as well as the imports OF it, so the plant that " +
      "shows the first half is the one the doNotFollow mutation for tests above declares; " +
      "the edge into tests/ is judged by the fixture-tree and bridge controls as well",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: lines(
      "      doNotFollow: { path: DO_NOT_FOLLOW },",
      '      exclude: { path: "^tests/" },',
    ),
  },
  {
    file: GENERATOR,
    name: "generator: exclude modules from the checker (C10-2)",
    witness:
      "production options: a module's public file importing another module's internals is " +
      "reported as rule-2-contracts-only-identity-access",
    shared:
      "exclude removes the edges INTO modules as well as the imports OF them; every rule-1 " +
      "and rule-2 plant goes red, and the public-file plant is the one the doNotFollow " +
      "mutation for modules above declares",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: lines(
      "      doNotFollow: { path: DO_NOT_FOLLOW },",
      '      exclude: { path: "^modules/" },',
    ),
  },
  // ---- round twelve, R12-2: one plant per IMPORT FORM, and the options pinned ----
  //
  // Round eleven loosened `doNotFollow` and `exclude` per SOURCE ROOT. None of
  // these loosened them per import form: a dynamic import(), a require(), an
  // export-from, a .mjs source, a .cjs source. Each below blinds every rule to
  // that form in every root; each has a plant of its own in
  // tests/boundaries/production-options.test.mjs. From the "includeOnly"
  // mutation down, a mutation is caught by the pin on the options object and
  // by no plant of its own, which is the point of the pin: it names a loosening
  // nobody has built a plant for.
  {
    file: GENERATOR,
    name: "generator: do not see a dynamic import() (R12-2)",
    witness:
      "production options: a dynamic import() of tenancy internals is reported as " +
      "rule-1-internals-private-tenancy",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: lines(
      "      doNotFollow: { path: DO_NOT_FOLLOW },",
      "      exclude: { dynamic: true },",
    ),
  },
  {
    file: GENERATOR,
    name: "generator: do not see a require() (R12-2)",
    witness:
      "production options: a require() in a js file of tenancy internals is reported as " +
      "rule-1-internals-private-tenancy",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: lines(
      "      doNotFollow: { path: DO_NOT_FOLLOW },",
      '      moduleSystems: ["es6", "tsd"],',
    ),
  },
  {
    file: GENERATOR,
    name: "generator: do not see an ES module import or export-from (R12-2)",
    witness:
      "production options: an export-from of tenancy internals is reported as " +
      "rule-1-internals-private-tenancy",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: lines(
      "      doNotFollow: { path: DO_NOT_FOLLOW },",
      '      moduleSystems: ["cjs", "amd", "tsd"],',
    ),
  },
  {
    file: RULES,
    name: "options: do not follow the imports of a .mjs file (R12-2)",
    witness:
      "production options: an mjs re-export of tenancy internals is reported as " +
      "rule-1-internals-private-tenancy",
    from: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|");',
    to:
      'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|") + "|' +
      BACKSLASH +
      BACKSLASH +
      '.mjs$";',
  },
  {
    file: RULES,
    name: "options: do not follow the imports of a .cjs file (R12-2)",
    witness:
      "production options: a require() in a cjs file of tenancy internals is reported as " +
      "rule-1-internals-private-tenancy",
    from: 'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|");',
    to:
      'export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|") + "|' +
      BACKSLASH +
      BACKSLASH +
      '.cjs$";',
  },
  {
    file: GENERATOR,
    name: "generator: exclude .cjs files from the checker (R12-2)",
    witness:
      "production options: a cjs re-export of tenancy internals is reported as " +
      "rule-1-internals-private-tenancy",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: lines(
      "      doNotFollow: { path: DO_NOT_FOLLOW },",
      '      exclude: { path: "' + BACKSLASH + BACKSLASH + '.cjs$" },',
    ),
  },
  {
    file: GENERATOR,
    name: "generator: judge only first-party source roots, not tests (R12-2)",
    witness: "production options: the option names are exactly the allowlist",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: lines(
      "      doNotFollow: { path: DO_NOT_FOLLOW },",
      '      includeOnly: "^(modules|packages|services|apps)/",',
    ),
  },
  {
    file: GENERATOR,
    name: "generator: add a field to doNotFollow (R12-2)",
    witness:
      "production options: the doNotFollow option is exactly the allowlisted pattern and " +
      "nothing else",
    from: "      doNotFollow: { path: DO_NOT_FOLLOW },",
    to: '      doNotFollow: { path: DO_NOT_FOLLOW, dependencyTypes: ["npm"] },',
  },
  {
    file: GENERATOR,
    name: "generator: read type-only imports another way (R12-2)",
    witness: "production options: the tsPreCompilationDeps option is exactly true",
    from: "      tsPreCompilationDeps: true,",
    to: '      tsPreCompilationDeps: "specify",',
  },
  {
    file: GENERATOR,
    name: "generator: name the tsconfig another way (R12-2)",
    witness:
      "production options: the tsConfig option is exactly the repository tsconfig and nothing else",
    from: '      tsConfig: { fileName: "tsconfig.json" },',
    to: '      tsConfig: { fileName: "./tsconfig.json" },',
  },
  {
    file: GENERATOR,
    name: "generator: add a resolve option (R12-2)",
    witness: "production options: the enhancedResolveOptions names are exactly the allowlist",
    from: '        exportsFields: ["exports"],',
    to: lines('        exportsFields: ["exports"],', '        mainFields: ["main"],'),
  },
  {
    file: GENERATOR,
    name: "generator: widen exportsFields (R12-2)",
    witness: "production options: the exportsFields resolve option is exactly the allowlist",
    from: '        exportsFields: ["exports"],',
    to: '        exportsFields: ["exports", "main"],',
  },
  {
    file: GENERATOR,
    name: "generator: drop a condition name (R12-2)",
    witness: "production options: the conditionNames resolve option is exactly the allowlist",
    from: '        conditionNames: ["import", "require", "node", "default", "types"],',
    to: '        conditionNames: ["import", "require", "node", "default"],',
  },
  {
    file: GENERATOR,
    name: "generator: stop resolving .cjs files (R12-2)",
    witness: "production options: the extensions resolve option is exactly the allowlist",
    from: '        extensions: [".ts", ".js", ".mjs", ".cjs"],',
    to: '        extensions: [".ts", ".js", ".mjs"],',
  },
  {
    file: GENERATOR,
    name: "generator: change the report options (R12-2)",
    witness: "production options: the reporterOptions option is exactly the allowlist",
    from: "      reporterOptions: { text: { highlightFocused: true } },",
    to: "      reporterOptions: { text: { highlightFocused: false } },",
  },
  // ---- round fourteen, R14-1: the rest of what the checker runs with ----------
  //
  // The R12-2 pin covered the options object. The checker CI runs is also
  // configured by the argument list of `pnpm boundaries:check` and by the
  // config module's top-level keys, and a one-line loosening of either hid a
  // live rule-1 and rule-5 violation with every check, test and mutation
  // green, since no mutation touched package.json's boundaries:check or the
  // config's top-level keys. production-options.test.mjs now cruises with the
  // arguments read from package.json and pins all three; each mutation below
  // is one loosening and names the pin written for it.
  {
    file: PACKAGE,
    name: "boundaries:check: exclude a path from the checker (R14-1)",
    witness: "production options: boundaries:check passes depcruise no --exclude",
    from: "&& depcruise --config",
    to: "&& depcruise --exclude ^services/api/src/plant-export-from --config",
  },
  {
    file: PACKAGE,
    name: "boundaries:check: do not follow what services import (R14-1)",
    witness: "production options: boundaries:check passes depcruise no --do-not-follow",
    from: "--config .dependency-cruiser.cjs modules",
    to: "--config .dependency-cruiser.cjs --do-not-follow ^services/ modules",
  },
  {
    file: PACKAGE,
    name: "boundaries:check: judge only modules (R14-1)",
    witness: "production options: boundaries:check passes depcruise no --include-only",
    from: ".cjs modules packages services",
    to: ".cjs --include-only ^modules/ modules packages services",
  },
  {
    file: PACKAGE,
    name: "boundaries:check: ignore known violations (R14-1)",
    witness: "production options: boundaries:check passes depcruise no --ignore-known",
    from: "generate-boundary-rules.mjs --check && depcruise",
    to: "generate-boundary-rules.mjs --check && depcruise --ignore-known",
  },
  {
    file: PACKAGE,
    name: "boundaries:check: stop scanning tests (R14-1)",
    witness: "production options: boundaries:check scans exactly modules, packages, services, apps and tests",
    from: 'services apps tests"',
    to: 'services apps"',
  },
  {
    // A flag none of the named pins above looks for: the allowlist of the
    // whole command is what catches it, which is the point of having one.
    file: PACKAGE,
    name: "boundaries:check: focus the checker on services (R14-1)",
    witness:
      "production options: boundaries:check is exactly the generation check and then depcruise " +
      "with the allowlisted arguments",
    from: "depcruise --config .dependency-cruiser.cjs",
    to: "depcruise --focus ^services/ --config .dependency-cruiser.cjs",
  },
  {
    file: GENERATOR,
    name: "generator: extend another config (R14-1)",
    witness: "production options: the config extends no other config",
    from: "    forbidden: rules,",
    to: lines('    extends: "./packages/contracts/zz-loose.json",', "    forbidden: rules,"),
  },
  {
    file: GENERATOR,
    name: "generator: add a top-level key beside forbidden and options (R14-1)",
    witness: "production options: the config's top-level keys are exactly forbidden and options",
    from: lines("      reporterOptions: { text: { highlightFocused: true } },", "    },", "  };"),
    to: lines(
      "      reporterOptions: { text: { highlightFocused: true } },",
      "    },",
      '    allowedSeverity: "ignore",',
      "  };",
    ),
  },
  // ---- round sixteen, CR-1: the same three flags written inside a short-flag cluster ----
  //
  // The CLI parser reads `-mx <re>` as `--metrics --exclude <re>`, and the
  // per-flag pins above matched only an argument that STARTS with the short
  // flag, so each of these left its own pin green (the allowlist and the
  // cruise were red). Each pattern differs from the R14-1 mutation's for the
  // same flag, so the two mutations are not killed by the same controls.
  {
    file: PACKAGE,
    name: "boundaries:check: exclude a path inside a short-flag cluster, -mx (CR-1)",
    witness: "production options: boundaries:check passes depcruise no --exclude",
    shared:
      "the per-flag pin is the one control for --exclude in every spelling; R14-1's mutation " +
      "proves the long spelling, this one the clustered short spelling",
    from: "--check && depcruise --config",
    to: "--check && depcruise -mx ^apps/ --config",
  },
  {
    file: PACKAGE,
    name: "boundaries:check: do not follow a path inside a short-flag cluster, -mX (CR-1)",
    witness: "production options: boundaries:check passes depcruise no --do-not-follow",
    shared:
      "the per-flag pin is the one control for --do-not-follow in every spelling; R14-1's " +
      "mutation proves the long spelling, this one the clustered short spelling",
    from: ".dependency-cruiser.cjs modules packages",
    to: ".dependency-cruiser.cjs -mX ^packages/ modules packages",
  },
  {
    file: PACKAGE,
    name: "boundaries:check: judge only one root inside a short-flag cluster, -mI (CR-1)",
    witness: "production options: boundaries:check passes depcruise no --include-only",
    shared:
      "the per-flag pin is the one control for --include-only in every spelling; R14-1's " +
      "mutation proves the long spelling, this one the clustered short spelling",
    from: "modules packages services apps",
    to: "-mI ^services/ modules packages services apps",
  },
  // ---- round sixteen, security S15-1: a lifecycle hook around a script CI runs ----
  //
  // pnpm runs pre<name> and post<name> around `pnpm <name>`; a hidden-and-
  // restored violation under tests/ passed boundaries:check with both hooks
  // present. The hooks here are inert: the sweep runs suites with node, not
  // pnpm, so only the pin can see them, which is the point.
  {
    file: PACKAGE,
    name: "package.json: run a pre hook before boundaries:check (S15-1)",
    witness: "ci workflow: package.json defines no pre hook for a script CI runs",
    from: '  "scripts": {',
    to: lines('  "scripts": {', '    "preboundaries:check": "node -e 0",'),
  },
  {
    file: PACKAGE,
    name: "package.json: run a post hook after boundaries:check (S15-1)",
    witness: "ci workflow: package.json defines no post hook for a script CI runs",
    from: '    "boundaries:generate": "node scripts/generate-boundary-rules.mjs",',
    to: lines(
      '    "postboundaries:check": "node -e 0",',
      '    "boundaries:generate": "node scripts/generate-boundary-rules.mjs",',
    ),
  },
  // ---- round seventeen, L1-L3: a script or hook that pnpm install runs ----
  //
  // Each key ran on a cold `pnpm install --frozen-lockfile` (pnpm 11.9.0); as
  // above, the sweep never installs, so only the pins can see them. A root
  // .pnpmfile.cjs/.mjs has no mutation: this harness rewrites an anchor in an
  // existing file and cannot plant a new one (declared non-coverage).
  ...["pnpm:devPreinstall", "install", "preprepare", "prepare", "postprepare"].map((key) => ({
    file: PACKAGE,
    name: `package.json: run a root ${key} script on install (L1)`,
    witness: `install lifecycle: package.json defines no root ${key} script`,
    from: '  "scripts": {',
    to: lines('  "scripts": {', `    "${key}": "node -e 0",`),
  })),
  ...["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"].map((key) => ({
    file: TENANCY_PACKAGE,
    name: `modules/tenancy/package.json: run the ${key} script on install (L2)`,
    witness: `install lifecycle: no workspace package defines the ${key} script`,
    from: '  "scripts": {',
    to: lines('  "scripts": {', `    "${key}": "node -e 0",`),
  })),
  {
    file: WORKSPACE,
    name: "workspace: name no package glob, so the package pins read nothing (L2)",
    witness: "install lifecycle: the workspace packages are read, so the package controls below read something",
    from: lines("packages:", '  - "apps/*"'),
    to: lines("package_globs:", '  - "apps/*"'),
  },
  {
    file: WORKSPACE,
    name: "workspace: load a pnpmfile through the pnpmfile setting (L3)",
    witness: "install lifecycle: pnpm-workspace.yaml sets no pnpmfile",
    from: lines("overrides:", '  fast-uri: "3.1.8"'),
    to: lines("pnpmfile: scripts/registry.mjs", "", "overrides:", '  fast-uri: "3.1.8"'),
  },
  {
    file: LOCKFILE,
    name: "lockfile: record a pnpmfile checksum, so a frozen install loads a pnpmfile (L3)",
    witness: "install lifecycle: pnpm-lock.yaml records no pnpmfileChecksum",
    from: lines("", "importers:", ""),
    to: lines("", "pnpmfileChecksum: sha256-0000000000000000000000000000000000000000000=", "", "importers:", ""),
  },
  // ---- round eleven, C10-3 and C10-4: the catch-all for an import that resolves to nothing ----
  {
    file: RULES,
    name: "backstop: stop reporting an import that resolves to nothing (C10-3)",
    witness:
      "control 1: a .js file imports internals through a percent-encoded scope (%40biztrust) " +
      "is reported as backstop-no-unresolvable-imports",
    from: lines("  rules.push({", '    name: "backstop-no-unresolvable-imports",'),
    to: lines("  [].push({", '    name: "backstop-no-unresolvable-imports",'),
  },
  {
    file: RULES,
    name: "backstop: report only what services import (C10-3)",
    witness:
      "control 1: a .js file imports internals through a Cyrillic lookalike letter is " +
      "reported as backstop-no-unresolvable-imports",
    from: '    from: { path: "^" + ROOTS + "/" },',
    to: '    from: { path: "^services/" },',
  },
  {
    file: RULES,
    name: "backstop: do not report what services import (C10-4)",
    witness:
      "control 5: a .js entry point imports a module's dist/ when nothing has been built is " +
      "reported as backstop-no-unresolvable-imports",
    from: '    from: { path: "^" + ROOTS + "/" },',
    to: '    from: { path: "^(?:modules|packages|apps)/" },',
  },
  {
    file: RULES,
    name: "backstop: do not report what modules import (C10-3)",
    witness:
      "production options: a js file in a module importing a double percent-encoded " +
      "directory is reported as backstop-no-unresolvable-imports",
    from: '    from: { path: "^" + ROOTS + "/" },',
    to: '    from: { path: "^(?:packages|services|apps)/" },',
  },
  {
    file: RULES,
    name: "backstop: do not report what apps import (C10-3)",
    witness:
      "production options: a js file in an app importing a double percent-encoded " +
      "directory is reported as backstop-no-unresolvable-imports",
    from: '    from: { path: "^" + ROOTS + "/" },',
    to: '    from: { path: "^(?:modules|packages|services)/" },',
  },
  // ---- round eleven, C10-1: first-party source where the checker does not look ----
  {
    file: MODULE_CHECK,
    name: "modules: do not refuse a tracked file under the root node_modules (C10-1)",
    witness: "a tracked file under the root node_modules is reported",
    from: "  const hidden = [UNFOLLOWED.thirdParty, UNFOLLOWED.linkFarm, UNFOLLOWED.buildOutput].map(",
    to: "  const hidden = [UNFOLLOWED.linkFarm, UNFOLLOWED.buildOutput].map(",
  },
  {
    file: MODULE_CHECK,
    name: "modules: do not refuse a tracked file under a package's node_modules (C10-1)",
    witness: "a tracked file under a package's node_modules is reported",
    from: "  const hidden = [UNFOLLOWED.thirdParty, UNFOLLOWED.linkFarm, UNFOLLOWED.buildOutput].map(",
    to: "  const hidden = [UNFOLLOWED.thirdParty, UNFOLLOWED.buildOutput].map(",
  },
  {
    file: MODULE_CHECK,
    name: "modules: do not refuse a tracked file under a package's dist (C10-1)",
    witness: "a tracked file under a package's dist is reported",
    from: "  const hidden = [UNFOLLOWED.thirdParty, UNFOLLOWED.linkFarm, UNFOLLOWED.buildOutput].map(",
    to: "  const hidden = [UNFOLLOWED.thirdParty, UNFOLLOWED.linkFarm].map(",
  },
  {
    file: MODULE_CHECK,
    name: "modules: refuse a tracked file under a directory merely NAMED node_modules (C10-1)",
    witness:
      "a tracked file under a directory merely NAMED node_modules or dist below src is not reported",
    from: "    (pattern) => new RegExp(pattern),",
    to: '    (pattern) => new RegExp(pattern.replace("^", "(^|/)")),',
  },
  {
    file: MODULE_CHECK,
    name: "modules: treat a git that cannot list the tracked files as an empty list (C10-1)",
    witness: "the check fails closed when git cannot list the tracked files",
    from: lines(
      '  const listed = execFileSync("git", ["ls-files", "-z"], {',
      "    cwd: ROOT,",
      '    encoding: "utf8",',
      "    maxBuffer: 64 * 1024 * 1024,",
      "  });",
    ),
    to: lines(
      '  let listed = "";',
      "  try {",
      '    listed = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });',
      "  } catch {",
      "    // fail open",
      "  }",
    ),
  },
  // ---- round eleven, S-6: the flow collection's brackets balance ------------------
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a flow collection with an opener left open (R11-S6)",
    witness: "test_a_flow_collection_with_an_opener_left_open_is_not_read_whole",
    from: "    return quote is not None, balanced and not expected",
    to: "    return quote is not None, balanced",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a flow collection closed by the wrong kind of bracket (R11-S6)",
    witness: "test_a_flow_collection_closed_by_the_wrong_kind_of_bracket_is_not_read_whole",
    from: "            if not expected or expected.pop() != char:",
    to: "            if not expected or expected.pop() is None:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a flow collection that closes before its last character (R11-S6)",
    witness: "test_a_flow_collection_that_closes_before_its_last_character_is_not_read_whole",
    from: "            elif not expected and index != len(value) - 1:",
    to: "            elif False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop checking that a flow collection's brackets balance at all (R11-S6)",
    witness: "test_a_flow_collection_with_an_opener_left_open_is_not_read_whole",
    shared:
      "removing the call removes all three arms at once, so the control that shows the " +
      "first arm is also the first to go red; the two arms above have controls of their own",
    from: "        if not _scan_flow(value)[1]:",
    to: "        if False:",
  },
  // ---- round eleven, S-7: a git that cannot answer widens the secret scan ----------
  {
    file: RECORDS,
    suite: "validator",
    name: "records: skip __pycache__ when git cannot say what is tracked (R11-S7)",
    witness: "test_a_pycache_directory_is_scanned_when_git_cannot_say_what_is_tracked",
    from: "        skip_segments = ()",
    to: '        skip_segments = ("__pycache__",)',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: skip node_modules when git cannot say what is tracked (R11-S7)",
    witness: "test_a_node_modules_directory_is_scanned_when_git_cannot_say_what_is_tracked",
    from: '        skip_prefixes = (".git/",)',
    to: '        skip_prefixes = (".git/", "node_modules/")',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: skip dist when git cannot say what is tracked (R11-S7)",
    witness: "test_a_top_level_dist_directory_is_scanned_when_git_cannot_say_what_is_tracked",
    from: '        skip_prefixes = (".git/",)',
    to: '        skip_prefixes = (".git/", "dist/")',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: scan git's own directory when git cannot say what is tracked (R11-S7)",
    witness: "test_the_git_directory_itself_is_not_scanned_when_git_cannot_say_what_is_tracked",
    from: '        skip_prefixes = (".git/",)',
    to: "        skip_prefixes = ()",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a git that cannot answer as an empty list of tracked files (R11-S7)",
    witness: "test_a_top_level_dist_directory_is_scanned_when_git_cannot_say_what_is_tracked",
    shared:
      "the old behaviour skips every build directory at once, so the control for one of them " +
      "is the first to go red; the per-directory mutations above have controls of their own",
    from: lines("    except (OSError, subprocess.CalledProcessError):", "        return None"),
    to: lines("    except (OSError, subprocess.CalledProcessError):", "        return set()"),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: do not treat an unanswered git as a separate case at all (R11-S7)",
    witness: "test_the_git_directory_itself_is_not_scanned_when_git_cannot_say_what_is_tracked",
    shared:
      "without the branch, an unanswered git crashes the scan instead of widening it; the " +
      "control that notices is the one that expects a clean pass where git is not scanned",
    from: "    if tracked is None:",
    to: "    if False:",
  },
  // ---- round eleven, spec n5: a checkpoint's chronology and its next action ---------
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept a checkpoint created in the future (R11-n5)",
    witness: "test_a_checkpoint_created_in_the_future_is_reported",
    from: "    if created is not None and created > datetime.now(timezone.utc) + CHECKPOINT_CLOCK_SLACK:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept a checkpoint created before one of its observations (R11-n5)",
    witness: "test_a_checkpoint_created_before_one_of_its_observations_is_reported",
    from: "            if observed is not None and observed > created:",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept a checkpoint naming a next action nothing defines (R11-n5)",
    witness: "test_a_checkpoint_naming_a_next_action_nothing_defines_is_reported",
    from: "        if isinstance(named, str) and named not in known:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: hold no exempt checkpoint to the ordering rule (R11-n5)",
    witness: "test_the_round_six_checkpoint_alone_is_exempt_from_the_ordering_rule",
    from: "    if created is not None and relative not in CHECKPOINT_ORDER_EXEMPT:",
    to: "    if created is not None:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: exempt every round checkpoint from the ordering rule (R11-n5)",
    witness: "test_another_checkpoint_with_the_same_inversion_is_not_exempt",
    from: "    if created is not None and relative not in CHECKPOINT_ORDER_EXEMPT:",
    to: lines(
      "    if created is not None and not relative.startswith(",
      '        "sessions/checkpoints/BIZTRUST-WP-001-review-round-"',
      "    ):",
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: exempt a second checkpoint from the ordering rule (R11-n5)",
    witness: "test_the_ordering_exemption_names_exactly_one_checkpoint",
    from: 'CHECKPOINT_ORDER_EXEMPT = {"sessions/checkpoints/BIZTRUST-WP-001-review-round-6.json"}',
    to: lines(
      "CHECKPOINT_ORDER_EXEMPT = {",
      '    "sessions/checkpoints/BIZTRUST-WP-001-review-round-6.json",',
      '    "sessions/checkpoints/BIZTRUST-WP-001-review-round-8.json",',
      "}",
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: exempt the round-six checkpoint from the next-action rule too (R11-n5)",
    witness: "test_the_exempt_round_six_checkpoint_is_still_held_to_the_other_two_rules",
    from: "        if isinstance(named, str) and named not in known:",
    to: "        if isinstance(named, str) and named not in known and relative not in CHECKPOINT_ORDER_EXEMPT:",
  },
  // ---- round eleven, S-8 and S-9: the CI workflow and the dependency override ------
  {
    file: CI_WORKFLOW,
    name: "ci: leave the job token in the checkout's git config (R11-S9)",
    witness: "ci workflow: the checkout step does not leave the job token in the git config",
    from: "          persist-credentials: false",
    to: "          persist-credentials: true",
  },
  {
    file: CI_WORKFLOW,
    name: "ci: drop the scope job's timeout (R11-S9)",
    witness: "ci workflow: every job has a timeout",
    from: lines("    timeout-minutes: 5", "    steps:"),
    to: "    steps:",
  },
  {
    file: CI_WORKFLOW,
    name: "ci: fetch a shallow history again (R11-S9)",
    witness:
      "ci workflow: the checkout step still fetches the whole history the signing check needs",
    from: "          fetch-depth: 0",
    to: "          fetch-depth: 1",
  },
  {
    file: CI_WORKFLOW,
    name: "ci: pin checkout by a movable tag again (R11-S9)",
    witness: "ci workflow: every action is pinned by a full commit SHA",
    from: "uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4",
    to: "uses: actions/checkout@v4",
  },
  {
    file: WORKSPACE,
    name: "workspace: override fast-uri with a range instead of an exact version (R11-S8)",
    witness: "workspace overrides: every override pins an exact version, not a range",
    from: '  fast-uri: "3.1.8"',
    to: '  fast-uri: "^3.1.8"',
  },
  // ---- round ten, S-2, S-4 and S-5: the secret scan and the tool powers ------
  {
    file: RECORDS,
    suite: "validator",
    name: "records: skip a tracked top-level dist directory in the secret scan (R10-S2)",
    witness: "test_a_credential_in_a_tracked_top_level_dist_directory_is_reported",
    from: "        if relative.startswith(skip_prefixes) and relative not in tracked:",
    to: "        if relative.startswith(skip_prefixes):",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: skip a tracked __pycache__ directory in the secret scan (R10-S2)",
    witness: "test_a_credential_in_a_tracked_pycache_directory_is_reported",
    from: lines(
      '            any(segment in relative.split("/") for segment in skip_segments)',
      "            and relative not in tracked",
    ),
    to: '            any(segment in relative.split("/") for segment in skip_segments)',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept a non-ASCII character in a tool power (R10-S4)",
    witness: "test_a_tool_power_with_a_non_ascii_character_is_refused",
    from: "            if not item.isascii():",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop recognising a GitLab access token (R10-S5)",
    witness: "test_a_gitlab_token_in_the_tree_is_reported",
    from: '        (re.compile(r"glpat-[A-Za-z0-9_-]{20,}"), "a GitLab access token"),',
    to: "",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop recognising an Anthropic API key (R10-S5)",
    witness: "test_an_anthropic_key_in_the_tree_is_reported",
    from: '        (re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"), "an Anthropic API key"),',
    to: "",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: stop recognising a Stripe test restricted key (R10-S5)",
    witness: "test_a_stripe_test_restricted_key_in_the_tree_is_reported",
    from: '        (re.compile(r"rk_test_[A-Za-z0-9]{20,}"), "a Stripe test restricted key"),',
    to: "",
  },
  // ---- round ten, R9-m3: control 8's own condition, and the checkpoint scan ----
  {
    file: RECORDS,
    suite: "validator",
    name: "records: validate a checkpoint against its schema without the required fields (R10-m3)",
    witness: "test_a_checkpoint_missing_a_required_field_is_reported",
    from: '    checkpoint_schema = load_schema("session-checkpoint.schema.json")',
    to: lines(
      "    checkpoint_schema = {",
      '        k: v for k, v in load_schema("session-checkpoint.schema.json").items() if k != "required"',
      "    }",
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read past a record in a subdirectory of the checkpoint directory (R10-m3)",
    witness: "test_a_checkpoint_in_a_subdirectory_is_reported",
    from: "        if path.parent != directory:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read past a record whose extension differs only in case (R10-m3)",
    witness: "test_a_checkpoint_with_an_upper_case_extension_is_reported",
    from: '        elif path.suffix.lower() == ".json":',
    to: "        elif False:",
  },
  // ---- round ten, R9-m1: every spelling of a by-name internals import ---------
  //
  // One family per mutation, each with a fixture of its own in packages/shared
  // (no other rule reports an import from there, so a rule that stops matching
  // leaves the file reported by nothing).
  {
    file: RULES,
    name: "rule 1 by package name: match the internal directory in one case only (R10-m1)",
    witness:
      "control 1: the same, with other upper and lower case (@BizTrust/Alpha/src/Internal) is " +
      "reported as rule-1-internals-private-by-name-alpha",
    from: "      const forms = new Set([ch.toLowerCase(), ch.toUpperCase()]);",
    to: "      const forms = new Set([ch]);",
  },
  {
    file: RULES,
    name: "by package name: match the scope and module names in one case only (R10-m1)",
    witness:
      "control 5: an entry point reaches past a contract by package name, spelled with other " +
      "case is reported as rule-5-entry-points-see-contracts-only-by-name",
    from:
      "    .map((ch) => (/[A-Za-z]/.test(ch) ? " + BT + "[" + DOLLAR + "{ch.toLowerCase()}" +
      DOLLAR + "{ch.toUpperCase()}]" + BT + " : rx(ch)))",
    to: "    .map((ch) => rx(ch))",
  },
  {
    file: RULES,
    name: "rule 1 by package name: stop matching a percent-encoded letter (R10-m1)",
    witness:
      "control 1: the same, with a percent-encoded letter (src/%69nternal) is reported as " +
      "rule-1-internals-private-by-name-alpha",
    from: '      return "(?:[" + [...forms].join("") + "]|" + codes.join("|") + ")";',
    to: '      return "(?:[" + [...forms].join("") + "])";',
  },
  {
    file: RULES,
    name: "rule 1 by package name: stop matching a backslash separator (R10-m1)",
    witness:
      "control 1: the same, with backslashes for separators (src backslash internal) is " +
      "reported as rule-1-internals-private-by-name-alpha",
    from: 'const SEP = "(?:[/' + BACKSLASH.repeat(4) + ']|%2[fF]|%5[cC])";',
    to: 'const SEP = "(?:/|%2[fF]|%5[cC])";',
  },
  {
    file: RULES,
    name: "rule 1 by package name: stop matching a percent-encoded slash (R10-m1)",
    witness:
      "control 1: the same, with a percent-encoded slash after the directory (internal%2Fx) is " +
      "reported as rule-1-internals-private-by-name-alpha",
    from: 'const SEP = "(?:[/' + BACKSLASH.repeat(4) + ']|%2[fF]|%5[cC])";',
    to: 'const SEP = "(?:[/' + BACKSLASH.repeat(4) + ']|%5[cC])";',
  },
  {
    file: RULES,
    name: "rule 1 by package name: stop matching a percent-encoded hash (R10-m1)",
    witness:
      "control 1: the same, with a percent-encoded hash after the directory (internal%23x) is " +
      "reported as rule-1-internals-private-by-name-alpha",
    from: 'const END = "(?:" + SEP + "|[?#]|%3[fF]|%23|$)";',
    to: 'const END = "(?:" + SEP + "|[?#]|%3[fF]|$)";',
  },
  {
    file: RULES,
    name: "rule 1 by package name: stop matching a percent-encoded query (R10-m1)",
    witness:
      "control 1: the same, with a percent-encoded query after the directory (internal%3Fx) is " +
      "reported as rule-1-internals-private-by-name-alpha",
    from: 'const END = "(?:" + SEP + "|[?#]|%3[fF]|%23|$)";',
    to: 'const END = "(?:" + SEP + "|[?#]|%23|$)";',
  },
  {
    file: RULES,
    name: "rule 1 by package name: stop matching a directory named with a query (R10-m1)",
    witness:
      "control 1: the same, naming the directory with a query and nothing after it (internal?x) " +
      "is reported as rule-1-internals-private-by-name-alpha",
    from: 'const END = "(?:" + SEP + "|[?#]|%3[fF]|%23|$)";',
    to: 'const END = "(?:" + SEP + "|[#]|%3[fF]|%23|$)";',
  },
  {
    file: RULES,
    name: "rule 1 by package name: stop matching a directory named with a hash (R10-m1)",
    witness:
      "control 1: the same, naming the directory with a hash and nothing after it (internal#x) " +
      "is reported as rule-1-internals-private-by-name-alpha",
    from: 'const END = "(?:" + SEP + "|[?#]|%3[fF]|%23|$)";',
    to: 'const END = "(?:" + SEP + "|[?]|%3[fF]|%23|$)";',
  },
  {
    file: RULES,
    name: "rule 1 by package name: stop allowing a dot segment after the scope (R10-m1)",
    witness:
      "control 1: the same, with a dot segment between the scope and the package " +
      "(@biztrust/./alpha) is reported as rule-1-internals-private-by-name-alpha",
    from:
      'const SCOPE = "^@" + caseless("biztrust") + SEP + "(?:' + BACKSLASH.repeat(2) +
      '." + SEP + "|" + SEP + ")*";',
    to: 'const SCOPE = "^@" + caseless("biztrust") + SEP;',
  },
  // ---- round ten, R9-m2: the compiler as a second layer ---------------------
  {
    file: TSCONFIG_BASE,
    name: "tsconfig: stop failing an unresolvable side-effect import (R10-m2)",
    witness:
      "typecheck: a side-effect import of a path that resolves to nothing fails the compiler",
    from: '    "noUncheckedSideEffectImports": true,',
    to: '    "noUncheckedSideEffectImports": false,',
  },
  // ---- round ten: a quoted spelling of a key is a repeat the repeat check never saw ----
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a quoted field name in badf/authority.yaml as a different field (R10-S1)",
    witness: "test_a_quoted_field_name_that_repeats_a_plain_one_is_refused",
    from: '            if refuse_key("badf/authority.yaml", number, field, problems):',
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a quoted entry name in badf/authority.yaml as a different entry (R10-S1)",
    witness: "test_a_quoted_entry_name_that_repeats_a_plain_one_is_refused",
    from: '            refuse_key("badf/authority.yaml", number, key, problems)',
    to: "            pass",
  },
  // ---- round ten: badf/gates.yaml and badf/lifecycle.yaml are read by a grammar now ----
  //
  // A pattern reader accepts what it does not match. parse_lists refuses instead,
  // and each refusal below has a fixture that breaks exactly that shape.
  {
    file: RECORDS,
    suite: "validator",
    name: "records: skip a tab in gates or lifecycle without saying so (R10-S1)",
    witness: "test_a_tab_in_the_gates_registry_is_refused",
    from: '            problems.append(f"{name} line {number}: contains a tab; this file is space-indented")',
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept an unknown top-level key that splits a list (R10-S1)",
    witness: "test_a_gates_registry_split_by_a_top_level_key_is_refused",
    from: lines(
      "                problems.append(",
      '                    f"{name} line {number}: unknown top-level key {key!r}. A key nothing reads "',
    ),
    to: lines(
      "                _ = (",
      '                    f"{name} line {number}: unknown top-level key {key!r}. A key nothing reads "',
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal top-level keys in gates or lifecycle (R10-S1)",
    witness: "test_a_gates_top_level_key_repeated_is_refused",
    from: '            refuse_repeat(name, number, key, "this file", seen_top, problems)',
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept an inline value on a gates or lifecycle list (R10-S1)",
    witness: "test_a_gates_list_with_an_inline_value_is_refused",
    from: lines(
      "                    problems.append(",
      '                        f"{name} line {number}: {key!r} carries an inline value; its entries "',
    ),
    to: lines(
      "                    _ = (",
      '                        f"{name} line {number}: {key!r} carries an inline value; its entries "',
    ),
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept an entry that does not open with its key (R10-S1)",
    witness: "test_a_gates_entry_that_does_not_open_with_its_key_is_refused",
    from: "            if match is None or match.group(1) != opener:",
    to: "            if match is None:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept a field the entry may not carry (R10-S1)",
    witness: "test_an_unknown_field_on_a_gate_is_refused",
    from: "            if field not in fields:",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a gates or lifecycle field whose quote never closes (R10-S1)",
    witness: "test_a_gates_field_that_opens_a_quote_is_refused",
    from: "            if refuse_value(name, number, field, value, problems):",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: keep the last of two equal fields in a gates or lifecycle entry (R10-S1)",
    witness: "test_a_gate_status_repeated_with_its_value_on_the_next_line_is_refused",
    from: "                name, number, field, f\"the entry at line {entry['__line__']}\", entry, problems",
    to: "                name, number, field, f\"the entry at line {entry['__line__']}\", {}, problems",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a gates or lifecycle top-level value whose quote never closes (R10-S1)",
    witness: "test_a_gates_top_level_value_that_opens_a_quote_is_refused",
    from: "                refuse_value(name, number, key, rest, problems)",
    to: "                pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a gate id whose quote never closes (R10-S1)",
    witness: "test_a_gate_id_that_opens_a_quote_is_refused",
    from: "            refuse_value(name, number, opener, value, problems)",
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: read a gates or lifecycle list item whose quote never closes (R10-S1)",
    witness: "test_a_lifecycle_list_item_that_opens_a_quote_is_refused",
    from: "            refuse_value(name, number, current, value, problems)",
    to: "            pass",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: record a gate twice under the same id (R10-S1)",
    witness: "test_a_gate_recorded_twice_is_refused",
    from: "        if gate_id in recorded:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: compare gate ids as written, not as YAML reads them (R10-S1)",
    witness: "test_a_gate_recorded_again_under_a_quoted_id_is_refused",
    from: '        gate_id = unquoted(gate_entry["id"])',
    to: '        gate_id = gate_entry["id"]',
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: accept the acceptance transition recorded twice (R10-S1)",
    witness: "test_the_acceptance_transition_recorded_twice_is_refused",
    from: "    if len(acceptance) > 1:",
    to: "    if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: find the forbidden sentence anywhere in the lifecycle text (R10-S1)",
    witness: "test_the_forbidden_sentence_only_in_a_comment_is_not_the_forbidden_list",
    from: '    forbidden = {unquoted(item) for item in parsed["items"]["forbidden"]}',
    to: lines(
      '    sentence = "Any transition into ACCEPTED made by the implementing agent"',
      "    forbidden = {sentence} if sentence in text else set()",
    ),
  },
];

// TEST-ONLY seam, read by tests/boundaries/mutation-check-guard.test.mjs.
// Every mutation above still runs, unmodified, whenever this is unset - a
// normal `pnpm check:mutations` never sets it. It exists because witnessing
// the EXIT-time half of the dirty-tree guard (below) needs a real,
// end-to-end run of this script, and paying the full four-minute,
// 125-mutation sweep for that would make every `pnpm verify` noticeably slower
// for a check that does not touch the sweep loop at all. Truncating the
// array (not skipping it) means the truncated run still exercises the exact
// same baseline-suite-then-loop-then-exit-check code path, just over fewer
// iterations.
if (process.env.MUTATION_CHECK_TEST_LIMIT !== undefined) {
  MUTATIONS.length = Math.max(0, Number(process.env.MUTATION_CHECK_TEST_LIMIT));
}

/**
 * The suites a mutation can be checked against, and the command each one is.
 *
 * There was one, hard-coded inside `runSuite`. Round four findings I6, I7
 * and I8 add refusals to `scripts/validate_continuity.py`, which the
 * boundary suite does not exercise at all - its witnesses live in
 * `tests/unit`, run by `pnpm test:validator`. A mutation to that file
 * checked against the boundary suite would SURVIVE every time and prove
 * nothing about the witness that actually covers it, which is the same
 * 'a rule that would stay green if it were deleted' defect one level up.
 *
 * Per-mutation rather than one combined run: the validator suite spawns a
 * Python process per test and takes ~8s, so running it for every mutation
 * would add ten minutes to `pnpm verify` for no added coverage - a mutation
 * to the boundary rules is not observable there.
 */
const SUITES = {
  boundaries: {
    label: 'node --test --test-reporter=tap "tests/boundaries/*.test.mjs"',
    argv: ["--test", "--test-reporter=tap", "tests/boundaries/*.test.mjs"],
    read: readTap,
  },
  validator: {
    label: "node scripts/python.mjs -m unittest discover -s tests/unit -v",
    argv: [join("scripts", "python.mjs"), "-m", "unittest", "discover", "-s", "tests/unit", "-v"],
    read: readUnittest,
  },
  // The signature check's git plumbing. Its controls build real repositories -
  // git init, two or three commits, a shallow clone, a spawned check apiece -
  // and take ~4.5s together, where the whole boundary suite takes ~2s. Adding
  // them to that glob would have made every one of the hundred-odd boundary
  // mutations pay for controls not one of them can move, which is minutes on
  // every `pnpm verify`. Same split, same reason, as `validator` above.
  signing: {
    label: 'node --test --test-reporter=tap "tests/signing/*.test.mjs"',
    argv: ["--test", "--test-reporter=tap", "tests/signing/*.test.mjs"],
    read: readTap,
  },
};

/** The suite a mutation is checked against when it names none. */
const DEFAULT_SUITE = "boundaries";

/**
 * Runs one suite and returns WHICH controls failed, not merely that some did.
 *
 * `spawnSync` rather than `execFileSync`: the two suites write their results
 * to different streams (TAP to stdout, unittest's verbose listing to stderr),
 * and execFileSync hands back only stdout on a green run - so the validator
 * suite's roster of test names would be thrown away exactly when it is
 * needed. spawnSync returns both streams whatever the exit status.
 */
function runSuite(suite = DEFAULT_SUITE) {
  const spec = SUITES[suite];
  if (spec === undefined) {
    throw new Error(
      `unknown suite ${JSON.stringify(suite)}; known: ${Object.keys(SUITES).join(", ")}`,
    );
  }
  const run = spawnSync(process.execPath, spec.argv, {
    cwd: WT_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Tells tests/boundaries/mutation-check-guard.test.mjs it is running
    // inside a mutation-check sweep already, so it does not spawn a nested
    // mutation-check.mjs of its own - see that file for why that would be
    // unbounded recursion rather than merely redundant.
    env: { ...process.env, MUTATION_CHECK_RUNNING: "1" },
  });
  if (run.error !== undefined) throw run.error;
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const { names, failed } = spec.read(output);
  return { status: run.status === 0 ? "GREEN" : "RED", names, failed, output };
}

/** Formats a control list for the overlap report, one indented line each. */
function indent(names) {
  return names.map((name) => `      ${name}\n`).join("");
}

function main() {
  // One baseline per suite ACTUALLY used by a mutation, not one fixed run:
  // a red suite makes every mutation checked against it meaningless, and a
  // suite no mutation names should not be paid for.
  const usedSuites = [...new Set(MUTATIONS.map((m) => m.suite ?? DEFAULT_SUITE))].sort();
  /** suite -> every control name that suite reported at baseline. */
  const roster = new Map();
  for (const suite of usedSuites) {
    const baseline = runSuite(suite);
    if (baseline.status !== "GREEN") {
      process.stderr.write(
        `MUTATION_CHECK FAIL the ${suite} baseline suite (${SUITES[suite].label}) is ` +
          `not green, so this run proves nothing. Fix the suite first.\n`,
      );
      return 2;
    }
    // A roster that names nothing, or names one control twice, is a defect in
    // this harness's own reading of the suite rather than a result - see
    // `rosterDefect`, where both halves are stated and witnessed.
    const defect = rosterDefect(suite, SUITES[suite].label, baseline.names);
    if (defect !== null) {
      process.stderr.write(`MUTATION_CHECK FAIL ${defect}.\n`);
      return 2;
    }
    roster.set(suite, new Set(baseline.names));
    process.stdout.write(
      `MUTATION_CHECK baseline GREEN ${suite}: ${baseline.names.length} controls\n`,
    );
  }
  process.stdout.write(
    `MUTATION_CHECK baseline GREEN (${usedSuites.join(", ")}), ` +
      `${MUTATIONS.length} mutations\n`,
  );

  // ---- what each mutation DECLARES, checked before anything is run --------
  //
  // These are defects in the mutation table itself, not results, so they are
  // decided statically: a mutation that names no witness is the "caught, so
  // presumed covered" hole this attribution exists to close, and a witness
  // naming a test that does not exist is a declaration that stopped testing
  // in the same way a lost anchor is. The sweep still runs, so one run
  // reports both the declaration defects and the control that actually
  // caught each mutation - which is what a reader needs to fix them.
  const { undeclared, unknownWitness, undeclaredSharing } = declarationDefects(
    MUTATIONS.map((mutation) => ({ ...mutation, suite: mutation.suite ?? DEFAULT_SUITE })),
    roster,
  );

  const survived = [];
  const anchorDefects = [];
  const misattributed = [];
  /** mutation name -> every control that went red under it, sorted. */
  const killedBy = new Map();

  for (const mutation of MUTATIONS) {
    const original = readFileSync(mutation.file, "utf8");
    const defect = anchorDefect(original, mutation.from, mutation.name);
    if (defect !== null) {
      // An anchor that no longer exists means the rule was rewritten and this
      // mutation silently stopped testing anything; an anchor that matches
      // TWICE means it rewrites whichever copy comes first, which need not be
      // the rule its name claims. Either is a failure, not a skip: both are
      // the same "passes whether or not it works" defect one level up.
      anchorDefects.push(defect);
      continue;
    }
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to), "utf8");
    let result;
    try {
      result = runSuite(mutation.suite ?? DEFAULT_SUITE);
    } finally {
      writeFileSync(mutation.file, original, "utf8");
    }
    if (result.status !== "RED") {
      process.stdout.write(`  SURVIVED  ${mutation.name}\n`);
      survived.push(mutation.name);
      continue;
    }

    const killers = [...new Set(result.failed)].sort();
    killedBy.set(mutation.name, killers);

    const witnessed = witnessedBy(mutation, killers);
    if (witnessed.length > 0) {
      const others = killers.length - witnessed.length;
      process.stdout.write(
        `  caught    ${mutation.name}\n      by ${witnessed.join(", ")}` +
          `${others > 0 ? ` (and ${others} other control(s))` : ""}\n`,
      );
      continue;
    }

    // Red, but not by the control that is supposed to prove this rule. The
    // suite reports a defect either way, so the nominal coverage number is
    // unchanged - and that reading is exactly what this attribution exists to
    // refuse: a mutation caught by a sibling is a rule whose own fixture
    // proves nothing about it.
    process.stdout.write(`  MISATTRIBUTED ${mutation.name}\n`);
    misattributed.push(
      `${mutation.name}\n      declared: ` +
        `${witnessesOf(mutation).join(", ") || "(nothing)"}\n` +
        (killers.length > 0
          ? `      actually caught by:\n${indent(killers)}`
          : `      caught by nothing this harness could name - the suite failed ` +
            `without naming a single failing test, so the red proves nothing:\n` +
            `${result.output.split(/\r?\n/).slice(-12).join("\n")}\n`),
    );
  }

  // Two mutations that die under exactly the same controls are the same
  // mutation as far as this suite can tell, whichever of them declares which
  // control. That is not always wrong - see `shared` - but it is never
  // something a reader should have to derive from the overlap report.
  const undeclaredTwins = indistinguishable(
    killedBy,
    new Map(MUTATIONS.map((mutation) => [mutation.name, reasonOf(mutation)])),
  );

  // ---- the two directions of the overlap, reported whatever the verdict ---
  //
  // Neither direction is automatically a defect. Both are places where the
  // count of mutations caught is larger than the number of independent things
  // actually proved, and a reader cannot see that from a pass line. The third
  // number is the granularity itself: how many mutations no control kills
  // alone. The counts always print; the listing behind them is long, churns
  // run to run, and is read once a defect is being chased, so it takes an
  // argument - and an ARGUMENT, not an environment variable, for the reason
  // the coverage gate's own seam is one: runSuite forwards the ambient
  // environment into every suite this sweep spawns.
  const { multiplyKilled, multiplyKilling, withoutExclusiveKiller } = overlaps(killedBy);
  process.stdout.write(
    `MUTATION_CHECK OVERLAP ${multiplyKilled.length} mutation(s) killed by more than ` +
      `one control, ${multiplyKilling.length} control(s) killing more than one ` +
      `mutation, ${withoutExclusiveKiller.length} mutation(s) no control kills alone` +
      `${LIST_OVERLAP ? "" : " (--overlap lists them)"}\n`,
  );
  if (LIST_OVERLAP) {
    for (const [name, killers] of multiplyKilled) {
      process.stdout.write(`  killed by ${killers.length} controls  ${name}\n${indent(killers)}`);
    }
    for (const [name, victims] of multiplyKilling) {
      process.stdout.write(`  kills ${victims.length} mutations  ${name}\n${indent(victims)}`);
    }
    if (withoutExclusiveKiller.length > 0) {
      process.stdout.write(`  no control kills these alone:\n${indent(withoutExclusiveKiller)}`);
    }
  }

  const declaredShared = MUTATIONS.filter((mutation) => reasonOf(mutation) !== null);
  if (declaredShared.length > 0) {
    process.stdout.write(
      `MUTATION_CHECK DECLARED NON-COVERAGE ${declaredShared.length} mutation(s) share ` +
        `a witness on purpose\n`,
    );
    for (const mutation of declaredShared) {
      process.stdout.write(`  ${mutation.name}\n      ${reasonOf(mutation)}\n`);
    }
  }

  for (const entry of anchorDefects) {
    process.stderr.write(`MUTATION_CHECK ANCHOR ${entry}\n`);
  }
  for (const name of survived) {
    process.stderr.write(`MUTATION_CHECK SURVIVED ${name}\n`);
  }
  for (const entry of undeclared) {
    process.stderr.write(`MUTATION_CHECK NO WITNESS ${entry}\n`);
  }
  for (const entry of unknownWitness) {
    process.stderr.write(`MUTATION_CHECK WITNESS NAMES NO TEST ${entry}\n`);
  }
  for (const entry of undeclaredSharing) {
    process.stderr.write(`MUTATION_CHECK SHARED WITNESS ${entry}\n`);
  }
  for (const entry of undeclaredTwins) {
    process.stderr.write(`MUTATION_CHECK INDISTINGUISHABLE ${entry}\n`);
  }
  for (const entry of misattributed) {
    process.stderr.write(`MUTATION_CHECK MISATTRIBUTED ${entry}\n`);
  }

  // The exit code and the line that explains it are both derived from one
  // alternation in mutation-attribution.mjs, and every term of it is
  // witnessed. Summing these by hand here is what let review of this task
  // delete a term and watch the sweep print every misattribution it found and
  // exit 0 anyway - the suite green while the rule did nothing, inside the
  // instrument built to measure exactly that.
  const { code, summary } = verdict({
    survived,
    anchorDefects,
    undeclared,
    unknownWitness,
    undeclaredSharing,
    undeclaredTwins,
    misattributed,
  });
  if (code !== 0) {
    process.stderr.write(`${summary}\n`);
    return code;
  }

  process.stdout.write(
    `MUTATION_CHECK PASS ${MUTATIONS.length} mutations, every one caught by its ` +
      `declared witness\n`,
  );
  return 0;
}

let exitCode;
try {
  exitCode = main();
} catch (error) {
  process.stderr.write(`MUTATION_CHECK FAIL check defect: ${error?.stack ?? error}\n`);
  exitCode = 2;
} finally {
  destroyWorktree(WT_ROOT);
}

// TEST-ONLY seam, read by tests/boundaries/mutation-check-guard.test.mjs: by
// design, nothing above this line ever dirties the REAL repository (that is
// the entire point of running against a worktree instead) - so proving the
// exit-time guard below actually fires needs some real dirt on the real tree
// at exactly this point, and there is no way to do that from an external
// test process without racing this script's own timing. Set only under an
// explicit env var no normal invocation ever sets, this writes one
// throwaway untracked file, lets the guard below see it, and removes it
// again once the exit code is decided - deterministic, not a sleep-and-hope.
const testDirtyAtExit = process.env.MUTATION_CHECK_TEST_DIRTY_AT_EXIT;
if (testDirtyAtExit) {
  writeFileSync(
    join(REAL_ROOT, testDirtyAtExit),
    "witness file for the mutation-check exit-time dirty-tree guard test\n",
    "utf8",
  );
}

// The dirty-tree guard's other half. Every mutation above was applied to and
// restored on the WORKTREE, never on the real repository, so this is a
// backstop rather than the primary defence - but the acceptance criterion for
// this task is exactly this check, so it runs unconditionally and wins over
// an otherwise-green result. A run that leaves the real tree dirty must not
// report PASS.
const dirtyAtExit = realTreeStatus();
if (dirtyAtExit.trim() !== "") {
  process.stderr.write(
    "MUTATION_CHECK FAIL the working tree is not clean at exit; a PASS must " +
      "not be reported against a mutated tracked file:\n" + dirtyAtExit,
  );
  if (exitCode === 0) exitCode = 2;
}

if (testDirtyAtExit) {
  try {
    rmSync(join(REAL_ROOT, testDirtyAtExit), { force: true });
  } catch {
    // best-effort; the test that set this env var also cleans up defensively
  }
}

process.exitCode = exitCode;
