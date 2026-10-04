/**
 * The module-package check.
 *
 * `scripts/check-module-packages.mjs` catches a directory that has drifted from
 * the registry: a package under `modules/` that no row registers, so no rule
 * was generated for it and it has no boundary at all.
 *
 * It had no test. Peer review F9: it worked when probed by hand, but nothing
 * witnessed it, which is the same defect as an untested rule one level up. A
 * check nobody has seen fail is indistinguishable from one that cannot fail.
 *
 * Each case builds a throwaway tree in a temp directory and runs the real
 * script against THAT copy. Nothing here ever writes to the committed
 * `modules/modules.yaml` or creates a directory under the real `modules/`.
 *
 * This used to write the real, tracked registry and restore it in a
 * `finally`. `node --test "tests/boundaries/*.test.mjs"` runs test FILES IN
 * PARALLEL, so while this suite's registry write was in flight,
 * `migration-lint.test.mjs` (running in a sibling process) could spawn the
 * lint against a half-written `modules/modules.yaml` and fail with
 * `registry has no version` against code that was completely correct - a
 * false failure, observed three times in one session, with no help from a
 * second human touching the tree. Working against a private copy removes the
 * shared mutable file entirely, so there is nothing left to race.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const REGISTRY = join(ROOT, "modules", "modules.yaml");

/** `cpSync` filter that leaves every `node_modules` directory behind: this
 * check never reads inside one, and a package-linked symlink under one
 * (`modules/identity-access/node_modules/@biztrust/tenancy`) has no business
 * being reproduced in a throwaway copy. */
function skipNodeModules(src) {
  return !src.split(/[\\/]/).includes("node_modules");
}

/**
 * Builds a throwaway copy of `scripts/` and `modules/` under a temp
 * directory, applies `changes` to the copy, runs `body` with the path to the
 * copy's own `check-module-packages.mjs` and the copy's root, and always
 * removes the copy afterwards. The real tree is never touched.
 */
function withTree(changes, body) {
  const dir = mkdtempSync(join(tmpdir(), "biztrust-module-packages-"));
  try {
    cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true, filter: skipNodeModules });
    cpSync(join(ROOT, "modules"), join(dir, "modules"), { recursive: true, filter: skipNodeModules });

    // The check asks git which files are tracked (round eleven, C10-1), so the
    // copy has to be a repository. Nothing is committed: `git ls-files` lists
    // the index, and only what a case stages with `git add -f` is in it.
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });

    for (const { dir: relDir, files } of changes.dirs ?? []) {
      mkdirSync(join(dir, relDir), { recursive: true });
      for (const [name, content] of Object.entries(files ?? {})) {
        writeFileSync(join(dir, relDir, name), content, "utf8");
      }
    }
    for (const [relative, content] of changes.tracked ?? []) {
      mkdirSync(dirname(join(dir, relative)), { recursive: true });
      writeFileSync(join(dir, relative), content, "utf8");
      execFileSync("git", ["add", "-f", relative], { cwd: dir, stdio: "ignore" });
    }
    if (changes.registry) {
      const registryPath = join(dir, "modules", "modules.yaml");
      writeFileSync(registryPath, changes.registry(readFileSync(registryPath, "utf8")), "utf8");
    }

    return body(join(dir, "scripts", "check-module-packages.mjs"), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `check-module-packages.mjs` at `checkPath` (default: the real,
 * committed one) with cwd `cwd` (default: the real repository root). */
function run(checkPath = join(ROOT, "scripts", "check-module-packages.mjs"), cwd = ROOT) {
  try {
    const stdout = execFileSync(process.execPath, [checkPath], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

test("the repository as committed passes", () => {
  const { code, out } = run();
  assert.equal(code, 0, `expected a clean tree to pass; got:\n${out}`);
  assert.match(out, /MODULE_PACKAGES PASS/);
});

test("a package directory that no registry row names is reported", () => {
  const result = withTree(
    { dirs: [{ dir: "modules/rogue/src/public", files: { "index.ts": "export const R = 1;\n" } }] },
    (checkPath, dir) => run(checkPath, dir),
  );
  assert.equal(result.code, 1, `expected an unregistered package to fail:\n${result.out}`);
  assert.match(result.out, /rogue/);
  assert.match(result.out, /no row in|not registered|has no boundary/i);
});

test("a registry row claiming a package that is absent is reported", () => {
  const result = withTree(
    {
      registry: (text) =>
        text.replace(
          "  - name: distribution\n    group: platform",
          "  - name: distribution\n    group: platform",
        ) +
        [
          "",
          "  - name: ghost",
          "    group: platform",
          "    owner_role: platform-engineer",
          "    contract: src/public/index.ts",
          "    schema: ghost",
          "    epic: FIXTURE",
          "    source: contract",
          "    package: true",
          "",
        ].join("\n"),
    },
    (checkPath, dir) => run(checkPath, dir),
  );
  assert.equal(result.code, 1, `expected a phantom package row to fail:\n${result.out}`);
  assert.match(result.out, /ghost/);
});

test("a registered package whose contract file is missing is reported", () => {
  const result = withTree(
    {
      dirs: [{ dir: "modules/hollow", files: { "package.json": '{"name":"@biztrust/hollow"}\n' } }],
      registry: (text) =>
        text +
        [
          "",
          "  - name: hollow",
          "    group: platform",
          "    owner_role: platform-engineer",
          "    contract: src/public/index.ts",
          "    schema: hollow",
          "    epic: FIXTURE",
          "    source: contract",
          "    package: true",
          "",
        ].join("\n"),
    },
    (checkPath, dir) => run(checkPath, dir),
  );
  assert.equal(result.code, 1, `expected a missing contract to fail:\n${result.out}`);
  assert.match(result.out, /hollow/);
  assert.match(result.out, /contract/i);
});

test("the check restores nothing: the registry is byte-identical afterwards", () => {
  const before = readFileSync(REGISTRY, "utf8");
  run();
  assert.equal(readFileSync(REGISTRY, "utf8"), before, "the check must not write");
});

test("every module directory on disk has a package.json", () => {
  // Not a mutation case; a standing invariant the check relies on.
  const { code } = run();
  assert.equal(code, 0);
  for (const name of ["tenancy", "identity-access", "audit", "platform-configuration"]) {
    assert.ok(
      existsSync(join(ROOT, "modules", name, "package.json")),
      `modules/${name} has no package.json, so its exports field cannot encapsulate it`,
    );
  }
});

// ---- round eleven, C10-1: first-party source where the checker does not look ----
//
// The dependency checker does not scan or follow the root node_modules, a
// package's own node_modules (pnpm's link farm) or a package's dist/. All three
// are gitignored, so first-party source can only sit there if someone runs
// `git add -f`, and the checker would then judge none of its imports.

for (const [where, relative] of [
  ["the root node_modules", "node_modules/plant/index.ts"],
  ["a package's node_modules", "services/api/node_modules/plant/index.ts"],
  ["a package's dist", "modules/tenancy/dist/plant.ts"],
]) {
  test(`a tracked file under ${where} is reported`, () => {
    const result = withTree({ tracked: [[relative, "export const hidden = 1;\n"]] }, (checkPath, dir) =>
      run(checkPath, dir),
    );
    assert.equal(result.code, 1, `expected a tracked file at ${relative} to fail:\n${result.out}`);
    assert.ok(result.out.includes(relative), `the report must name ${relative}:\n${result.out}`);
    assert.match(result.out, /the dependency checker does not scan or follow/);
  });
}

test("a tracked file under a directory merely NAMED node_modules or dist below src is not reported", () => {
  const result = withTree(
    {
      tracked: [
        ["services/api/src/node_modules/plant.ts", "export const a = 1;\n"],
        ["services/api/src/dist/plant.ts", "export const b = 1;\n"],
        ["services/api/src/node_modules-bridge.ts", "export const c = 1;\n"],
      ],
    },
    (checkPath, dir) => run(checkPath, dir),
  );
  assert.equal(result.code, 0, `source is followed wherever it sits, so it must not be refused:\n${result.out}`);
});

test("the check fails closed when git cannot list the tracked files", () => {
  // A .git that points nowhere, so git answers "not a git repository" here
  // and does not climb to whatever repository the temp directory sits in.
  const dir = mkdtempSync(join(tmpdir(), "biztrust-module-packages-nogit-"));
  try {
    writeFileSync(join(dir, ".git"), "gitdir: ./nowhere\n", "utf8");
    cpSync(join(ROOT, "scripts"), join(dir, "scripts"), { recursive: true, filter: skipNodeModules });
    cpSync(join(ROOT, "modules"), join(dir, "modules"), { recursive: true, filter: skipNodeModules });
    const result = run(join(dir, "scripts", "check-module-packages.mjs"), dir);
    assert.equal(result.code, 2, `expected exit 2, a check that could not run:\n${result.out}`);
    assert.match(result.out, /MODULE_PACKAGES FAIL check defect/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
