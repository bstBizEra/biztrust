/**
 * The CI workflow's own hardening, witnessed.
 *
 * Round ten, security S-9. `.github/workflows/ci.yml` is a governed path and
 * the thing every required check runs through, yet nothing read it: a later
 * edit could put the job token back into the checkout's git config, drop the
 * `scope` job's timeout, or move an action back to a movable tag, and every
 * check would stay green. This reads the file as text (no YAML dependency is
 * installed, and adding one is not an agent's decision) and asserts the four
 * properties that round established.
 *
 * It is a text check of a fixed shape, not a YAML parser: it finds a job by its
 * two-space-indented key under `jobs:` and a step by its `- name:` line. That is
 * all this file's layout needs, and a layout change that defeats it fails the
 * "finds both jobs" control rather than passing silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SPELLINGS, topLevelKeys, trackedManifests } from "../../scripts/install-surface.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const workspaceText = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");

/** The `scripts` of the package.json in `dir`, relative to the repository root. */
const scriptsOf = (dir) => JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")).scripts ?? {};

/** The text of each job under `jobs:`, keyed by job id. */
function jobs(text) {
  const after = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const parts = after.split(/^  ([a-z][a-z0-9_-]*):\s*$/m);
  const byId = {};
  for (let index = 1; index < parts.length; index += 2) byId[parts[index]] = parts[index + 1];
  return byId;
}

/** The text of the step whose `- name:` is `name`, up to the next step. */
function step(job, name) {
  const start = job.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `no step named ${name}`);
  const rest = job.slice(start + 1);
  const next = rest.search(/^ {6}- name: /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const byId = jobs(workflow);

test("ci workflow: the jobs are found, so the controls below read something", () => {
  assert.deepEqual(Object.keys(byId).sort(), ["scope", "verify"]);
});

test("ci workflow: the checkout step does not leave the job token in the git config", () => {
  const checkout = step(byId.verify, "Checkout");
  assert.match(checkout, /^ {10}persist-credentials: false$/m);
});

test("ci workflow: the checkout step still fetches the whole history the signing check needs", () => {
  const checkout = step(byId.verify, "Checkout");
  assert.match(checkout, /^ {10}fetch-depth: 0$/m);
});

test("ci workflow: every job has a timeout", () => {
  for (const [id, text] of Object.entries(byId)) {
    assert.match(text, /^ {4}timeout-minutes: [1-9][0-9]*$/m, `the ${id} job has no timeout-minutes`);
  }
});

test("ci workflow: every action is pinned by a full commit SHA", () => {
  const uses = [...workflow.matchAll(/^\s*uses: (\S+)/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 4, `expected the four actions, found ${uses.join(", ")}`);
  for (const reference of uses) {
    assert.match(reference, /@[0-9a-f]{40}$/, `${reference} is not pinned by a full commit SHA`);
  }
});

// ---- round ten, security S-8: an override is an exact version ---------------------
//
// An override with a range (`^3.1.8`) floats to a later release the next time the
// lockfile is regenerated, which is a dependency decision nobody made. The
// lockfile already pinned 3.1.8; the override is what would have moved it.

test("workspace overrides: every override pins an exact version, not a range", () => {
  const block = workspaceText.split(/^overrides:\s*$/m)[1];
  assert.ok(block !== undefined, "pnpm-workspace.yaml has no overrides block, so there is nothing to pin");
  const entries = [...block.matchAll(/^ {2}([^\s:#][^:]*):\s*(.+?)\s*$/gm)];
  assert.ok(entries.length >= 1, "the overrides block names no override");
  for (const [, name, value] of entries) {
    assert.match(value, /^"?[0-9]+\.[0-9]+\.[0-9]+"?$/, `the override of ${name} is ${value}, not an exact version`);
  }
});

// ---- round sixteen, security S15-1: no hook runs around a script CI runs -------
//
// pnpm runs `pre<name>` before and `post<name>` after `pnpm <name>`, so the
// command a CI step runs is more than the script string the boundary pins read.
// Two hook lines in package.json, one moving a violating file out of `tests/`
// and one moving it back, left `pnpm boundaries:check` at exit 0 over a live
// rule-1 violation with every test green, and touched no path CODEOWNERS
// routes. The script names are read from this workflow's `run: pnpm <name>`
// lines rather than written out here, so a step added later is covered too.

/** The script name of every `run: pnpm <name>` line in the workflow, in order. */
const ciScripts = [...workflow.matchAll(/^\s*(?:- )?run:\s+pnpm\s+(?:run\s+)?([^\s#]+)/gm)].map((match) => match[1]);

const scripts = scriptsOf(".");

/** The `<prefix><name>` hooks package.json defines for a script CI runs. */
function hooks(prefix) {
  assert.ok(ciScripts.length >= 1, "no `run: pnpm <script>` line was read from ci.yml, so no hook is checked");
  return ciScripts.map((name) => `${prefix}${name}`).filter((hook) => Object.hasOwn(scripts, hook));
}

test("ci workflow: the pnpm scripts it runs are read, so the hook controls below read something", () => {
  assert.ok(ciScripts.includes("boundaries:check"), `boundaries:check is not among ${ciScripts.join(", ")}`);
});

test("ci workflow: package.json defines no pre hook for a script CI runs", () => {
  const found = hooks("pre");
  assert.deepEqual(found, [], `pnpm runs these before a script CI runs, and no check reads them: ${found.join(", ")}`);
});

test("ci workflow: package.json defines no post hook for a script CI runs", () => {
  const found = hooks("post");
  assert.deepEqual(found, [], `pnpm runs these after a script CI runs, and no check reads them: ${found.join(", ")}`);
});

// ---- round seventeen, L1-L3: no script or hook runs during CI's install -------
//
// `pnpm install` runs more than the pre/post hooks above. On a cold install
// (no node_modules, as in CI) pnpm 11.9.0 ran every key below in the root
// manifest and in a package manifest, and it loaded a root `.pnpmfile.cjs` /
// `.pnpmfile.mjs` or the file a `pnpmfile` setting names; a root `prepare`
// that hid a tests/ leak left boundaries:check at exit 0 (run
// R14-1-20261003T1554). Root `preinstall`/`postinstall` are also the pre/post
// hooks of CI's `pnpm install` step, and are listed here as well so that their
// refusal does not depend on how ci.yml spells that step (round eighteen, CR17-4).
//
// Round eighteen, K1 (code CR17-1, CR17-2; controls C17-1, C17-2; security
// S17-2). The manifests are the ones git tracks, not the ones a reading of the
// `packages:` globs reaches: a glob with a trailing comment or two spaces after
// its dash was skipped, and a `package.yaml` or `package.json5` was never read,
// while pnpm ran the scripts of all of them. A manifest outside the workspace
// is read too, because a `file:` dependency can install it.

const ROOT_INSTALL_SCRIPTS = [
  "pnpm:devPreinstall",
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
];
const PACKAGE_INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];

/** Every tracked manifest's path, or the error git gave: a git that cannot answer is not an empty answer. */
const manifests = (() => {
  try {
    return { paths: trackedManifests(ROOT) };
  } catch (error) {
    return { paths: [], error };
  }
})();

/** Path -> parsed manifest, for each tracked manifest this test can parse. */
const parsed = new Map();
for (const path of manifests.paths) {
  if (!path.endsWith("package.json")) continue;
  try {
    parsed.set(path, JSON.parse(readFileSync(join(ROOT, path), "utf8")));
  } catch {
    // refused below as a manifest this test cannot read
  }
}

/** The `scripts` of the parsed manifest at `path`. */
const manifestScripts = (path) => Object(parsed.get(path)?.scripts ?? {});

test("install lifecycle: the tracked manifests are read, so the manifest controls below read something", () => {
  assert.equal(manifests.error, undefined, `git could not list the tracked manifests: ${manifests.error}`);
  assert.ok(manifests.paths.includes("package.json"), "the root package.json was not among the tracked manifests read");
  assert.ok(manifests.paths.some((path) => path !== "package.json"), "no package manifest below the root was read");
});

/** A fresh directory under the system temp directory, removed after `body` runs in it. */
function inTempDir(prefix, body) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("install lifecycle: the manifest read lists every tracked package.json, package.yaml and package.json5, and nothing else", () => {
  inTempDir("biztrust-manifests-", (dir) => {
    const tracked = ["package.json", "a/package.yaml", "b/c/package.json5", "d/package.json", "e/notpackage.json", "f/package.json.bak"];
    for (const path of [...tracked, "g/package.json"]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), "{}\n", "utf8");
    }
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["add", "--", ...tracked], { cwd: dir, stdio: "ignore" });
    assert.deepEqual(trackedManifests(dir).sort(), ["a/package.yaml", "b/c/package.json5", "d/package.json", "package.json"]);
  });
});

test("install lifecycle: the manifest read fails closed when git cannot list the tracked files", () => {
  // A .git that points nowhere, so git answers "not a git repository" here and
  // does not climb to whatever repository the temp directory sits in.
  inTempDir("biztrust-manifests-nogit-", (dir) => {
    writeFileSync(join(dir, ".git"), "gitdir: ./nowhere\n", "utf8");
    writeFileSync(join(dir, "package.json"), "{}\n", "utf8");
    assert.throws(() => trackedManifests(dir));
  });
});

test("install lifecycle: every tracked manifest is a package.json this test can parse", () => {
  // pnpm also reads package.yaml and package.json5, whose scripts it ran on a
  // cold install; no parser for either is installed, so either is refused.
  const unread = manifests.paths.filter((path) => !parsed.has(path));
  assert.deepEqual(unread, [], `pnpm install reads these manifests, and this test cannot: ${unread.join(", ")}`);
});

for (const key of ROOT_INSTALL_SCRIPTS) {
  test(`install lifecycle: package.json defines no root ${key} script`, () => {
    assert.ok(!Object.hasOwn(manifestScripts("package.json"), key), `pnpm install runs the root ${key} script, and no check reads it`);
  });
}

for (const key of PACKAGE_INSTALL_SCRIPTS) {
  test(`install lifecycle: no package manifest below the root defines the ${key} script`, () => {
    const found = [...parsed.keys()].filter((path) => path !== "package.json" && Object.hasOwn(manifestScripts(path), key));
    assert.deepEqual(found, [], `pnpm install runs ${key} in these packages, and no check reads it: ${found.join(", ")}`);
  });
}

test("install lifecycle: there is no root .pnpmfile.cjs or .pnpmfile.mjs", () => {
  const found = [".pnpmfile.cjs", ".pnpmfile.mjs"].filter((name) => existsSync(join(ROOT, name)));
  assert.deepEqual(found, [], `pnpm install loads ${found.join(", ")}, and no check reads it`);
});

// ---- round eighteen, K2 (code CR17-3; controls C17-3; security S17-1; spec S17-1) ----
//
// A line regex for `pnpmfile:` missed the same key written "quoted", 'quoted'
// or as a `? explicit` key, and the sibling `globalPnpmfile`; pnpm 11.9.0
// loaded the file each one names on a cold frozen install. The keys are now
// read by `topLevelKeys`, which refuses a top-level line it cannot read rather
// than skipping it. A pnpmfile that exports no hooks records no
// pnpmfileChecksum and its install passes, so the checksum pin below catches
// only a pnpmfile that exports hooks; the setting pins are what catch the rest.

/** The top-level keys of `text`, or the error the reader gave. */
function keysOf(text) {
  try {
    return { keys: topLevelKeys(text) };
  } catch (error) {
    return { keys: [], error };
  }
}

const lockText = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
const KEYS = { "pnpm-workspace.yaml": keysOf(workspaceText), "pnpm-lock.yaml": keysOf(lockText) };

for (const [file, expected] of [
  ["pnpm-workspace.yaml", ["packages", "overrides"]],
  ["pnpm-lock.yaml", ["lockfileVersion", "importers"]],
]) {
  test(`install lifecycle: every top-level key of ${file} is read`, () => {
    const { keys, error } = KEYS[file];
    assert.equal(error, undefined, `${file} has a top-level line the key reader cannot read: ${error?.message}`);
    const names = keys.map(({ key }) => key);
    for (const key of expected) assert.ok(names.includes(key), `the key reader did not find ${key} in ${file}`);
  });
}

test("install lifecycle: the key reader decodes a double-quoted key's escapes", () => {
  assert.deepEqual(topLevelKeys('"pnpm\\u0066ile": x\n'), [{ key: "pnpmfile", spelling: "double-quoted", line: 1 }]);
});

test("install lifecycle: the key reader breaks lines where YAML does, on a lone carriage return", () => {
  assert.deepEqual(topLevelKeys("overrides:\rpnpmfile: x\n").map(({ key }) => key), ["overrides", "pnpmfile"]);
});

const PNPMFILE_PINS = [
  { file: "pnpm-workspace.yaml", what: "sets no pnpmfile", refuses: (key) => key === "pnpmfile" },
  {
    file: "pnpm-workspace.yaml",
    what: "sets no other pnpmfile setting (globalPnpmfile)",
    refuses: (key) => key !== "pnpmfile" && /pnpmfile/i.test(key),
  },
  { file: "pnpm-lock.yaml", what: "records no pnpmfileChecksum", refuses: (key) => /pnpmfile/i.test(key) },
];

for (const { file, what, refuses } of PNPMFILE_PINS) {
  for (const spelling of SPELLINGS) {
    const suffix = spelling === "plain" ? "" : ` written as ${spelling === "explicit" ? "an" : "a"} ${spelling} key`;
    test(`install lifecycle: ${file} ${what}${suffix}`, () => {
      const found = KEYS[file].keys.filter((entry) => entry.spelling === spelling && refuses(entry.key));
      assert.deepEqual(
        found,
        [],
        file === "pnpm-lock.yaml"
          ? "the lockfile carries a pnpmfile checksum, which pnpm records only for a pnpmfile that exports hooks"
          : "pnpm install loads the file this setting names",
      );
    });
  }
}

// ---- round eighteen, K3 (security S17-4): a local dependency's build script ----
//
// A `file:` dependency on a tracked directory plus an `allowBuilds` entry for it
// ran the dependency's postinstall on a cold frozen install. Without the entry
// pnpm 11.9.0 refuses the build (ERR_PNPM_IGNORED_BUILDS), and it ignored
// `pnpm.onlyBuiltDependencies` in package.json. Both halves are refused.

const BUILD_PERMISSIONS = ["allowBuilds", "onlyBuiltDependencies", "onlyBuiltDependenciesFile", "dangerouslyAllowAllBuilds"];

test("install lifecycle: pnpm-workspace.yaml grants no dependency a build permission", () => {
  const found = KEYS["pnpm-workspace.yaml"].keys.filter(({ key }) => BUILD_PERMISSIONS.includes(key));
  assert.deepEqual(found, [], "pnpm install runs the lifecycle scripts of the dependencies these settings allow");
});

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

test("install lifecycle: no tracked manifest depends on a local path", () => {
  const found = [];
  for (const [path, manifest] of parsed) {
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(Object(manifest[field] ?? {}))) {
        if (/^\s*(?:file:|link:|\.{0,2}\/|~\/|[A-Za-z]:[\\/])/.test(String(spec))) found.push(`${path} ${field}.${name}: ${spec}`);
      }
    }
  }
  assert.deepEqual(found, [], "pnpm install installs a local path, whose own scripts no check reads");
});
