/**
 * The boundary generator's --check, witnessed.
 *
 * The WP-001 independent review (issue #8, finding A2) disabled the staleness
 * comparison in scripts/generate-boundary-rules.mjs and hand-edited a rule out
 * of .dependency-cruiser.cjs: boundaries:check, all 176 boundary tests and
 * check:coverage stayed green. The comparison was the only thing enforcing
 * "a generated file is never hand-edited", and nothing watched it.
 *
 * These tests run the real script against copies of the generated files in a
 * temporary directory, passed by --out-dir. An argument, not an environment
 * variable: DEC-026 records why a test seam must not be reachable from the
 * ambient environment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(ROOT, "scripts", "generate-boundary-rules.mjs");
const GENERATED = [".dependency-cruiser.cjs", "tsconfig.paths.json"];

function run(args) {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function withCopies(fn) {
  const dir = mkdtempSync(join(tmpdir(), "biztrust-boundary-gen-"));
  try {
    for (const name of GENERATED) copyFileSync(join(ROOT, name), join(dir, name));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--check --out-dir passes on current copies of the generated files", () => {
  withCopies((dir) => {
    const { code, out } = run(["--check", "--out-dir", dir]);
    assert.equal(code, 0, `current copies must pass --check:\n${out}`);
  });
});

test("--check fails on a hand-edited .dependency-cruiser.cjs, naming it stale", () => {
  withCopies((dir) => {
    const file = join(dir, ".dependency-cruiser.cjs");
    const edited = readFileSync(file, "utf8").replace('"severity": "error"', '"severity": "warn"');
    assert.notEqual(edited, readFileSync(file, "utf8"), "the plant must change the file");
    writeFileSync(file, edited, "utf8");
    const { code, out } = run(["--check", "--out-dir", dir]);
    assert.equal(code, 1, `a hand edit must FAIL --check; got ${code}:\n${out}`);
    assert.match(out, /\.dependency-cruiser\.cjs is stale/, out);
  });
});

test("--check fails on a missing tsconfig.paths.json, naming it missing", () => {
  withCopies((dir) => {
    unlinkSync(join(dir, "tsconfig.paths.json"));
    const { code, out } = run(["--check", "--out-dir", dir]);
    assert.equal(code, 1, `a missing generated file must FAIL --check; got ${code}:\n${out}`);
    assert.match(out, /tsconfig\.paths\.json is missing/, out);
  });
});
