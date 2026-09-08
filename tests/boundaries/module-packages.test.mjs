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
 * Each case builds a throwaway tree, runs the real script against it, and
 * restores. Nothing here mutates the committed registry.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CHECK = join(ROOT, "scripts", "check-module-packages.mjs");
const REGISTRY = join(ROOT, "modules", "modules.yaml");

function run() {
  try {
    const stdout = execFileSync(process.execPath, [CHECK], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * The SHALLOWEST path segment of `dir` that does not exist yet.
 *
 * Removing only the leaf leaves its new parents behind. That happened: a probe
 * created `modules/rogue/src/public`, cleanup removed `public`, and
 * `modules/rogue` survived into the next test and failed it. Deleting from the
 * shallowest new directory is what actually restores the tree.
 */
function shallowestNew(dir) {
  const parts = dir.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    const candidate = join(ROOT, ...parts.slice(0, i));
    if (!existsSync(candidate)) return candidate;
  }
  return null;
}

/** Runs `body` with the tree temporarily modified, then always restores. */
function withTree(changes, body) {
  const registry = readFileSync(REGISTRY, "utf8");
  const created = [];
  try {
    for (const { dir, files } of changes.dirs ?? []) {
      const toRemove = shallowestNew(dir);
      if (toRemove !== null) created.push(toRemove);
      mkdirSync(join(ROOT, dir), { recursive: true });
      for (const [name, content] of Object.entries(files ?? {})) {
        writeFileSync(join(ROOT, dir, name), content, "utf8");
      }
    }
    if (changes.registry) writeFileSync(REGISTRY, changes.registry(registry), "utf8");
    return body();
  } finally {
    writeFileSync(REGISTRY, registry, "utf8");
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
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
    run,
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
    run,
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
    run,
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
