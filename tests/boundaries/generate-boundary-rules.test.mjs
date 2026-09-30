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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { staleOutputs } from "../../scripts/generate-boundary-rules.mjs";

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

// ---------------------------------------------------------------------------
// Round seven, controls N3. The three tests above exercise only the branch of
// the script that takes --out-dir, so `if (outDir && found !== wanted)` left
// every one of them green while the real-root `--check` - the one CI runs -
// compared nothing. Two more witnesses, neither of which goes through --out-dir.
// ---------------------------------------------------------------------------

test("the comparison both paths share reports stale, missing and current outputs", () => {
  const files = new Map([
    ["/a/current", "same"],
    ["/a/stale", "old"],
  ]);
  const read = (path) => files.get(path) ?? null;
  assert.deepEqual(
    staleOutputs(
      [
        ["/a/current", "same", "current.cjs"],
        ["/a/stale", "new", "stale.cjs"],
        ["/a/absent", "new", "absent.json"],
      ],
      read,
    ),
    ["stale.cjs is stale", "absent.json is missing"],
  );
  assert.deepEqual(staleOutputs([["/a/current", "same", "current.cjs"]], read), []);
});

test("--check with no --out-dir compares the files at the repository root", () => {
  // The path CI runs. A copy of the script, its three imports, the registry and
  // the two generated files is built in a temporary root, so the script's own
  // default paths resolve THERE and the real tree is never edited.
  const root = mkdtempSync(join(tmpdir(), "biztrust-boundary-root-"));
  try {
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "modules"), { recursive: true });
    for (const name of ["generate-boundary-rules.mjs", "registry.mjs", "boundary-rules.mjs"]) {
      copyFileSync(join(ROOT, "scripts", name), join(root, "scripts", name));
    }
    copyFileSync(join(ROOT, "modules", "modules.yaml"), join(root, "modules", "modules.yaml"));
    for (const name of GENERATED) copyFileSync(join(ROOT, name), join(root, name));

    const check = () => {
      try {
        const out = execFileSync(process.execPath, [join(root, "scripts", "generate-boundary-rules.mjs"), "--check"], {
          cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, out };
      } catch (error) {
        return { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
      }
    };

    const fresh = check();
    assert.equal(fresh.code, 0, `current files at the root must pass --check:\n${fresh.out}`);

    const file = join(root, ".dependency-cruiser.cjs");
    const original = readFileSync(file, "utf8");
    const edited = original.replace('"severity": "error"', '"severity": "warn"');
    assert.notEqual(edited, original, "the plant must change the file");
    writeFileSync(file, edited, "utf8");
    const stale = check();
    assert.equal(stale.code, 1, `a hand edit at the root must FAIL --check; got ${stale.code}:\n${stale.out}`);
    assert.match(stale.out, /\.dependency-cruiser\.cjs is stale/, stale.out);

    writeFileSync(file, original, "utf8");
    unlinkSync(join(root, "tsconfig.paths.json"));
    const missing = check();
    assert.equal(missing.code, 1, `a missing file at the root must FAIL --check; got ${missing.code}:\n${missing.out}`);
    assert.match(missing.out, /tsconfig\.paths\.json is missing/, missing.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
