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
const SIGNING_CHECK = join(WT_ROOT, "scripts", "check-signing.mjs");
// Not a script. The ORDER of the verify chain is a control - the JS signing
// policy reader is fail-closed only because validate:records runs before
// check:signing - and a control that lives in data rather than in code is
// still a control, so it is mutated like one.
const PACKAGE = join(WT_ROOT, "package.json");

/** Joins anchor lines, so no source string carries an embedded newline. */
const lines = (...parts) => parts.join("\n");

// A backtick and a dollar, spelled out. An anchor that quotes a template
// literal from the source cannot itself be a template literal: String.raw
// still interpolates ${...}, so the anchor would evaluate rather than match.
const BT = String.fromCharCode(96);
const DOLLAR = String.fromCharCode(36);

const MUTATIONS = [
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
      '      path: "^modules/[^/]+/src/",',
      '      pathNot: "^modules/[^/]+/src/public/index\\\\.ts$",',
    ),
    to: lines(
      '      path: "^modules/[^/]+/src/",',
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
    // seat does - and every seat in badf/agents.yaml records held_by: null.
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
