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
 * Exit codes: 0 every mutation caught; 1 at least one survived; 2 the baseline
 * suite was not green, the working tree was not clean at start, the working
 * tree was not clean at exit, or the worktree itself could not be created -
 * any of which means this run proves nothing.
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
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ROOT as REAL_ROOT } from "./registry.mjs";

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
 * unreclaimed, every interrupted run during this script's 60-80 second
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
    from: '      from: { pathNot: ' + BT + '^modules/' + DOLLAR + '{rx(m.name)}/' + BT + ' },',
    to: '      from: { pathNot: "^modules/" },',
  },
  {
    file: RULES,
    name: "rule 2: allow a cross-module import of any public file",
    from: '        pathNot: "^modules/[^/]+/src/public/index\\\\.ts$",',
    to: '        pathNot: "^modules/[^/]+/src/public/",',
  },
  {
    file: RULES,
    name: "rule 3: stop forbidding cycles",
    from: '    to: { circular: true },',
    to: '    to: { circular: false },',
  },
  {
    file: RULES,
    name: "rule 4: only the package named shared may not import a module",
    from: '    from: { path: "^packages/" },',
    to: '    from: { path: "^packages/shared/" },',
  },
  {
    file: RULES,
    name: "rule 5: allow an entry point to import any public file, not the contract",
    from: '      pathNot: "^modules/[^/]+/src/public/index\\\\.ts$",',
    to: '      pathNot: "^modules/[^/]+/src/public/",',
  },
  {
    file: RULES,
    name: "rule 5b: only a module may not import an entry point",
    from: '    from: { pathNot: "^(services|apps)/" },',
    to: '    from: { path: "^modules/" },',
  },
  {
    file: RULES,
    name: "rule 5: narrow entry points to services only, dropping apps",
    from: '    from: { path: "^(services|apps)/" },',
    to: '    from: { path: "^services/" },',
  },
  {
    file: RULES,
    name: "rule 5b: narrow the entry-point target to services only, dropping apps",
    from: '    to: { path: "^(services|apps)/" },',
    to: '    to: { path: "^services/" },',
  },
  {
    file: RULES,
    name: "rule 6: only a service may not import a test package",
    from: '    from: { pathNot: "^tests/" },',
    to: '    from: { path: "^services/" },',
  },
  {
    file: RULES,
    name: "rule 7: let the control plane call a module contract",
    from: '    from: { path: "^apps/control-plane/" },',
    to: '    from: { path: "^apps/nothing-matches-this/" },',
  },

  // ---- the migration lint -------------------------------------------------
  {
    file: LINT,
    name: "scrub: stop unquoting double-quoted identifiers",
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
    from: '      if (target.schema === null) {',
    to: '      if (false) {',
  },
  {
    file: LINT,
    name: "M1: stop refusing search_path",
    from: '    if (/\\bSET\\s+(?:LOCAL\\s+|SESSION\\s+)?search_path\\b/i.test(statement)) {',
    to: '    if (false) {',
  },
  {
    file: LINT,
    name: "M1: stop denying by default on an unmodelled statement",
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
    from:
      '  return { targets, understood: targets.some((t) => t.resolvesStatement) };',
    to: '  const isDDL = /^\\s*(?:CREATE|ALTER|DROP)\\b/i.test(statement);\n  return { targets, understood: !isDDL || targets.length > 0 };',
  },
  {
    file: LINT,
    name: "M1: stop modelling COPY as a target of the schema it writes into",
    from: '  scan(new RegExp(String.raw`\\bCOPY\\s+(${ID})(?:\\.(${ID}))?`, "gi"), (m) => {\n    if (m[2] === undefined) pushResolved(null, m[1], m[0], "COPY");\n    else pushResolved(m[1], m[2], m[0], "COPY");\n  });',
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling MERGE INTO as a target of the schema it writes into",
    from: '  scan(new RegExp(String.raw`\\bMERGE\\s+INTO\\s+(${ID})(?:\\.(${ID}))?`, "gi"), (m) => {\n    if (m[2] === undefined) pushResolved(null, m[1], m[0], "MERGE INTO");\n    else pushResolved(m[1], m[2], m[0], "MERGE INTO");\n  });',
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling REFRESH MATERIALIZED VIEW as a target of the schema it refreshes",
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
    from: '      pushCommaSeparatedTargets(rest, "LOCK", pushResolved);',
    to: '      pushCommaSeparatedTargets(rest.split(",")[0], "LOCK", pushResolved);',
  },
  {
    file: LINT,
    name: "M1: ANALYZE reads only the first name in a comma-separated table list again",
    from: '      pushCommaSeparatedTargets(m[1], "ANALYZE", pushResolved);',
    to: '      pushCommaSeparatedTargets(m[1].split(",")[0], "ANALYZE", pushResolved);',
  },
  {
    file: LINT,
    name: "M1: VACUUM reads only the first name in a comma-separated table list again",
    from: '      pushCommaSeparatedTargets(m[1], "VACUUM", pushResolved);',
    to: '      pushCommaSeparatedTargets(m[1].split(",")[0], "VACUUM", pushResolved);',
  },
  {
    file: LINT,
    name: "M1: stop modelling REINDEX as a target of the schema it touches",
    from: "  scan(\n    new RegExp(\n      String.raw`\\bREINDEX\\s+(?:\\([^)]*\\)\\s+)?(?:INDEX|TABLE|SCHEMA|DATABASE|SYSTEM)\\s+(?:CONCURRENTLY\\s+)?(${ID})(?:\\.(${ID}))?`,\n      \"gi\",\n    ),\n    (m) => {\n      if (m[2] === undefined) pushResolved(null, m[1], m[0], \"REINDEX\");\n      else pushResolved(m[1], m[2], m[0], \"REINDEX\");\n    },\n  );",
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling CLUSTER as a target of the schema it touches",
    from: '  scan(new RegExp(String.raw`\\bCLUSTER\\s+(?:VERBOSE\\s+)?(${ID})(?:\\.(${ID}))?`, "gi"), (m) => {\n    if (m[2] === undefined) pushResolved(null, m[1], m[0], "CLUSTER");\n    else pushResolved(m[1], m[2], m[0], "CLUSTER");\n  });',
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling SELECT ... INTO as a target of the schema it creates a table in",
    from: '      if (m[2] === undefined) pushResolved(null, m[1], m[0], "SELECT INTO", "table");\n      else pushResolved(m[1], m[2], m[0], "SELECT INTO", "table");',
    to: '      void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling CREATE SCHEMA and DROP SCHEMA",
    from: '    (m) => pushResolved(m[2], null, m[0], ' + BT + DOLLAR + '{m[1].toUpperCase()} SCHEMA' + BT + '),',
    to: '    () => {},',
  },
  {
    file: LINT,
    name: "M1: stop modelling ALTER ... SET SCHEMA",
    from: '    (m) => pushResolved(m[1], null, m[0], "SET SCHEMA"),',
    to: '    () => {},',
  },
  {
    file: LINT,
    name: "M2: drop the unqualified-REFERENCES half",
    from: '  for (const m of statement.matchAll(unqualified)) {',
    to: '  for (const m of []) {',
  },
  {
    file: LINT,
    name: "M3: stop refusing DELETE and DROP on the audit schema",
    from: 'const AUDIT_FORBIDDEN = ["UPDATE", "DELETE", "TRUNCATE", "DROP"];',
    to: 'const AUDIT_FORBIDDEN = ["UPDATE", "TRUNCATE"];',
  },
  {
    file: LINT,
    name: "M3: stop refusing an audit column drop (its own sub-check)",
    from: '        report("M3", "a column drop is refused on the audit schema");',
    to: '        void 0;',
  },
  {
    file: LINT,
    name: "M3: stop refusing an audit column type change (its own sub-check)",
    from: '        report("M3", "a column type change is refused on the audit schema");',
    to: '        void 0;',
  },
  {
    file: LINT,
    name: "M4: anchor the stems so a prefix like policyholder escapes",
    from: '  { label: "policy", pattern: /^polic(y|ies)/i },',
    to: '  { label: "policy", pattern: /^polic(y|ies)$/i },',
  },
  {
    file: LINT,
    name: "M4: revert to a matcher blind to the plural",
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
    from: '  "CREATE VIEW",\n',
    to: "",
  },
  {
    file: LINT,
    // Added by ruling on review of this task, not the original brief: SELECT
    // ... INTO creates a table exactly as CREATE TABLE does. Caught by R3-29
    // (M4) and R3-30 (M5).
    name: "M4/M5: drop SELECT INTO from the table-creating verb set",
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
    from: "  scan(\n    new RegExp(\n      String.raw`\\bALTER\\s+${RENAMEABLE_TYPES}\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${ID})(?:\\.(${ID}))?\\s+RENAME\\s+TO\\s+(${ID})`,\n      \"gi\",\n    ),\n    (m) => {\n      const kind = relationKind(m[1]);\n      if (m[3] === undefined) pushResolved(null, m[4], m[0], \"RENAME TO\", kind);\n      else pushResolved(m[2], m[4], m[0], \"RENAME TO\", kind);\n    },\n  );",
    to: "  void 0;",
  },
  {
    file: LINT,
    // Narrower than the mutation above: the scan still runs and the target
    // still exists, but M4's own filter stops accepting the RENAME TO verb,
    // so the target it produces is never checked against a domain stem.
    name: "M4: stop accepting RENAME TO as a verb this rule checks",
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
    from: '  if (normalised === "FOREIGN TABLE") return "foreign table";',
    to: "  if (false) return \"foreign table\";",
  },
  {
    file: LINT,
    // Same defect, the view/materialized-view half. Caught by R3-24, R3-25,
    // R3-26 and R3-28.
    name: "M4/M5: relationKind stops labelling a view as one",
    from: '  if (normalised === "VIEW" || normalised === "MATERIALIZED VIEW") return "view";',
    to: "  if (false) return \"view\";",
  },
  {
    file: LINT,
    name: "M5: stop requiring tenant_id",
    from: '    if (created && !/\\btenant_id\\b/i.test(statement)) {',
    to: '    if (false) {',
  },
  {
    file: LINT,
    name: "M5: make the not-tenant-owned marker file-wide again",
    from: '      if (exemptStatements.has(statement)) {',
    to: '      if (exemptStatements.size > 0) {',
  },
  {
    file: LINT,
    name: "M6: stop rejecting an unregistered migration directory",
    from: '    if (!schemaOf.has(entry)) {',
    to: '    if (false) {',
  },
  {
    file: LINT,
    name: "walk: revert to a non-recursive directory read",
    from: "      if (statSync(full).isDirectory()) walk(full);",
    to: "      if (statSync(full).isDirectory()) continue;",
  },
  {
    file: LINT,
    name: "scrub: blank literals in a separate pass, as before (the apostrophe hole)",
    from: '      if (!/^[A-Za-z0-9_]+$/.test(inner)) oddIdentifiers.push(inner);',
    to: "      if (false) oddIdentifiers.push(inner);",
  },
  {
    file: LINT,
    name: "scrub: stop refusing a non-ASCII character in an unquoted identifier",
    from: "    if (sql.codePointAt(i) > 127) {\n      nonAscii.add(sql[i]);\n      out.push(sql[i]);\n    } else {",
    to: "    if (false) {\n      nonAscii.add(sql[i]);\n      out.push(sql[i]);\n    } else {",
  },
  {
    file: LINT,
    name: "M1: stop refusing a dollar-quoted body",
    from: "  if (dollarQuoted > 0) {",
    to: "  if (false) {",
  },
  {
    file: LINT,
    name: "M6: skip a non-directory under the migrations root, as before",
    from: "    if (!statSync(dir).isDirectory()) {",
    to: "    if (!statSync(dir).isDirectory()) { continue; } if (false) {",
  },
  {
    file: LINT,
    name: "walk: match the .sql extension case-sensitively again",
    from: '      else if (entry.toLowerCase().endsWith(".sql")) found.push(full);',
    to: '      else if (entry.endsWith(".sql")) found.push(full);',
  },
  {
    file: LINT,
    name: "walk: stop reporting a file this lint would not read",
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
    from: '  "FROM",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating JOIN as a cross-schema read",
    from: '  "JOIN",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating USING as a cross-schema read",
    from: '  "USING",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating PARTITION OF as a cross-schema structural coupling",
    from: '  "PARTITION\\\\s+OF",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating INHERIT/INHERITS as a cross-schema structural coupling",
    from: '  "INHERITS?",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating LIKE as a cross-schema structural coupling",
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
    from:
      '  return { targets, understood: targets.some((t) => t.resolvesStatement) };',
    to: '  return { targets, understood: targets.length > 0 };',
  },
  {
    file: LINT,
    // I3: the whole declaration-position type scan. Caught by R6-4.
    name: "M1: stop scanning for a schema-qualified type in declaration position",
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
    from: '  String.raw`[(,]\\s*${ID}\\s+`,\n',
    to: "",
  },
  {
    file: LINT,
    // I4, first half: `INHERIT` (singular) is a different keyword from
    // `INHERITS`, and the ALTER form was never matched. Narrowing the
    // alternation back to the plural reproduces exactly that. Caught by
    // R6-5, not by R3-35 (whose CREATE form still says INHERITS).
    name: "M1: narrow the INHERITS alternation back to the plural CREATE spelling",
    from: '  "INHERITS?",\n',
    to: '  "INHERITS",\n',
  },
  {
    file: LINT,
    // I4, second half: `ATTACH PARTITION` is its own entry beside
    // `PARTITION OF`, and is independently deletable. Caught by R6-6.
    name: "M1: stop treating ATTACH PARTITION as a cross-schema structural coupling",
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
    from:
      "      const alterRelation = String.raw`\\bALTER\\s+${RENAMEABLE_TYPES}\\b`;",
    to: "      const alterRelation = String.raw`\\bALTER\\s+TABLE\\b`;",
  },
  {
    file: LINT,
    // The single-quoted function body: as unreadable to this lint as a
    // dollar-quoted one, and refused only in the $$ spelling before.
    // Caught by R6-10.
    name: "M1: stop refusing a function body written as a single-quoted string literal",
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
    from: "function main() {\n  let registry;",
    to: "function main() {\n  return 0;\n  let registry;",
  },
  {
    file: GATE,
    // Caught twice over: the independently-derived count in the PASS-line
    // test drops by four, and the unwitnessed-verb test stops being reported.
    name: "coverage gate: stop asking whether the audit verbs are witnessed",
    from: "  for (const verb of AUDIT_FORBIDDEN) {",
    to: "  for (const verb of []) {",
  },
  {
    file: GATE,
    name: "coverage gate: stop asking whether the P0 domain stems are witnessed",
    from: "  for (const { label } of P0_FORBIDDEN_TABLE_STEMS) {",
    to: "  for (const { label } of []) {",
  },
  {
    file: GATE,
    name: "coverage gate: stop asking whether the generated rule families are witnessed",
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
    from: lines("    );", "    return 1;", "  }", "", "  process.stdout.write("),
    to: lines("    );", "    return 0;", "  }", "", "  process.stdout.write("),
  },
  {
    file: CODEOWNERS,
    // --check is the entire enforcement: without it a hand edit of the
    // generated routing file stands. Caught by the stale/missing test, which
    // makes a real stale copy through the CODEOWNERS_TEST_OUT seam.
    name: "codeowners: --check accepts a stale generated file",
    from: "    if (found !== content) {",
    to: "    if (false) {",
  },
  {
    file: CODEOWNERS,
    // A routing entry with no owner or no verifier becomes an UNOWNED
    // governance path rather than a refusal - which is how a review
    // requirement disappears with nothing recording that.
    name: "codeowners: stop refusing a routing entry that records no owner or verifier",
    from: "        throw new RegistryError(`routing entry ${path || \"?\"} records no ${label}`);",
    to: "        continue;",
  },
  {
    file: CODEOWNERS,
    // The seat stops being emitted at all: every path becomes unowned. Caught
    // by the team-slug test and by the byte-equality test against the real
    // .github/CODEOWNERS.
    name: "codeowners: emit no team slug for a seat that names a declared role",
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
    from: "    for skill_id, pinned in sorted(PINNED_SKILL_STATUS.items()):",
    to: "    for skill_id, pinned in []:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // Narrower: the pinned ids must still all be PRESENT, but any status is
    // accepted. This is `write-a-migration: BLOCKED -> AVAILABLE`, exactly.
    name: "records: accept any status on a pinned skill, so a BLOCKED skill can be made AVAILABLE",
    from: "        if SKILL_STATUS_RANK.get(status, -1) < SKILL_STATUS_RANK[pinned]:",
    to: "        if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    // I8's superset half: without it the pin is a floor the data can outgrow
    // - a new skill, at any status, is simply unprotected.
    name: "records: stop requiring every recorded skill to be pinned in the validator",
    from: lines("        if skill_id in PINNED_SKILL_STATUS:", "            continue"),
    to: lines("        if True:", "            continue"),
  },
  {
    file: RECORDS,
    suite: "validator",
    // I6: an empty registry is not a registry with nothing forbidden; it is
    // one that says nothing, which a caller reads as permission.
    name: "records: stop refusing a skills registry that records no skill",
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
    from: "            if field not in SKILL_FIELDS:",
    to: "            if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: silently skip an unknown field on a role instead of refusing it",
    from: "                if field not in ROLE_FIELDS:",
    to: "                if False:",
  },
  {
    file: RECORDS,
    suite: "validator",
    name: "records: silently skip an unknown field on a routing entry instead of refusing it",
    from: "                if field not in ROUTING_FIELDS:",
    to: "                if False:",
  },
];

// TEST-ONLY seam, read by tests/boundaries/mutation-check-guard.test.mjs.
// Every mutation above still runs, unmodified, whenever this is unset - a
// normal `pnpm check:mutations` never sets it. It exists because witnessing
// the EXIT-time half of the dirty-tree guard (below) needs a real,
// end-to-end run of this script, and paying the full 60-80 second, 63
// mutation sweep for that would make every `pnpm verify` noticeably slower
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
    label: 'node --test "tests/boundaries/*.test.mjs"',
    argv: ["--test", "tests/boundaries/*.test.mjs"],
  },
  validator: {
    label: "node scripts/python.mjs -m unittest discover -s tests/unit",
    argv: [join("scripts", "python.mjs"), "-m", "unittest", "discover", "-s", "tests/unit"],
  },
};

/** The suite a mutation is checked against when it names none. */
const DEFAULT_SUITE = "boundaries";

function runSuite(suite = DEFAULT_SUITE) {
  const spec = SUITES[suite];
  if (spec === undefined) {
    throw new Error(
      `unknown suite ${JSON.stringify(suite)}; known: ${Object.keys(SUITES).join(", ")}`,
    );
  }
  try {
    execFileSync(process.execPath, spec.argv, {
      cwd: WT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Tells tests/boundaries/mutation-check-guard.test.mjs it is running
      // inside a mutation-check sweep already, so it does not spawn a nested
      // mutation-check.mjs of its own - see that file for why that would be
      // unbounded recursion rather than merely redundant.
      env: { ...process.env, MUTATION_CHECK_RUNNING: "1" },
    });
    return "GREEN";
  } catch {
    return "RED";
  }
}

function main() {
  // One baseline per suite ACTUALLY used by a mutation, not one fixed run:
  // a red suite makes every mutation checked against it meaningless, and a
  // suite no mutation names should not be paid for.
  const usedSuites = [...new Set(MUTATIONS.map((m) => m.suite ?? DEFAULT_SUITE))].sort();
  for (const suite of usedSuites) {
    if (runSuite(suite) !== "GREEN") {
      process.stderr.write(
        `MUTATION_CHECK FAIL the ${suite} baseline suite (${SUITES[suite].label}) is ` +
          `not green, so this run proves nothing. Fix the suite first.\n`,
      );
      return 2;
    }
  }
  process.stdout.write(
    `MUTATION_CHECK baseline GREEN (${usedSuites.join(", ")}), ` +
      `${MUTATIONS.length} mutations\n`,
  );

  const survived = [];
  const missing = [];

  for (const mutation of MUTATIONS) {
    const original = readFileSync(mutation.file, "utf8");
    if (!original.includes(mutation.from)) {
      // An anchor that no longer exists means the rule was rewritten and this
      // mutation silently stopped testing anything. That is a failure, not a
      // skip: it is the same "passes whether or not it works" defect one level
      // up.
      missing.push(mutation.name);
      continue;
    }
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to), "utf8");
    let result;
    try {
      result = runSuite(mutation.suite ?? DEFAULT_SUITE);
    } finally {
      writeFileSync(mutation.file, original, "utf8");
    }
    if (result === "RED") {
      process.stdout.write(`  caught    ${mutation.name}\n`);
    } else {
      process.stdout.write(`  SURVIVED  ${mutation.name}\n`);
      survived.push(mutation.name);
    }
  }

  for (const name of missing) {
    process.stderr.write(`MUTATION_CHECK ANCHOR LOST ${name}\n`);
  }
  for (const name of survived) {
    process.stderr.write(`MUTATION_CHECK SURVIVED ${name}\n`);
  }

  if (survived.length > 0 || missing.length > 0) {
    process.stderr.write(
      `MUTATION_CHECK FAIL ${survived.length} mutation(s) survived, ` +
        `${missing.length} anchor(s) lost. A surviving mutation is a rule no ` +
        `fixture enforces; a lost anchor is a mutation that stopped testing.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `MUTATION_CHECK PASS ${MUTATIONS.length} mutations, every one caught\n`,
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
