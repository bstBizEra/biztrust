/**
 * The coverage gate, witnessed.
 *
 * Round four finding I9: `scripts/coverage-gate.mjs` is the instrument this
 * repository built to answer "is every named protection witnessed by
 * something?" - and it was witnessed by nothing. Inserting `return 0;` as the
 * first statement of its `main()` made it print nothing, exit 0, and
 * `pnpm verify` sailed straight through. No test referenced it, and
 * `mutation-check.mjs`'s `runSuite()` runs only `tests/boundaries/*.test.mjs`,
 * none of which spawned it. The one protection built to find unwitnessed
 * protections was the unwitnessed one.
 *
 * Three properties are asserted here, and each is what a different mutation
 * would break:
 *
 *   1. On this repository the gate PASSES, and reports a count this test
 *      derives INDEPENDENTLY - from the same three sources the gate derives
 *      it from (the audit verb list, the domain stem list, the generated rule
 *      families), imported here rather than copied. `return 0;` prints no
 *      count at all; dropping any one of the three loops prints a smaller
 *      one.
 *   2. When a named protection has no witness, the gate FAILS with exit 1 and
 *      names the protection. Two cases, one per source of protections: an
 *      audit verb whose control is missing from the migration suite, and a
 *      generated rule family missing from the boundary suite.
 *   3. The gate's own exit code, not merely its message: a gate that reports
 *      a gap and returns 0 is a gate that does not gate.
 *
 * The gate reads the two test files it checks from the repository. Proving it
 * fails needs test files that are MISSING a witness, and this repository's own
 * must not be edited to produce that (it would dirty the working tree, which
 * `check:mutations` refuses). `COVERAGE_GATE_TEST_TESTS_DIR` - a TEST-ONLY
 * seam a normal `pnpm check:coverage` never sets - points it at a temporary
 * copy instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadRegistry } from "../../scripts/registry.mjs";
import { AUDIT_FORBIDDEN, P0_FORBIDDEN_TABLE_STEMS } from "../../scripts/migration-lint.mjs";
import { buildRules } from "../../scripts/boundary-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const GATE = join(ROOT, "scripts", "coverage-gate.mjs");
const MIGRATION_TESTS = join(HERE, "migration-lint.test.mjs");
const BOUNDARY_TESTS = join(HERE, "boundary-rules.test.mjs");

/** Runs the gate and returns { code, out }. */
function gate(env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [GATE], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/**
 * A temporary directory holding the two test files the gate reads, each
 * passed through `edit` first. Returns the directory; the caller removes it.
 */
function testsDirWith(edit) {
  const dir = mkdtempSync(join(tmpdir(), "biztrust-coverage-gate-"));
  writeFileSync(
    join(dir, "migration-lint.test.mjs"),
    edit("migration-lint.test.mjs", readFileSync(MIGRATION_TESTS, "utf8")),
    "utf8",
  );
  writeFileSync(
    join(dir, "boundary-rules.test.mjs"),
    edit("boundary-rules.test.mjs", readFileSync(BOUNDARY_TESTS, "utf8")),
    "utf8",
  );
  return dir;
}

/** The number of named protections the gate must be counting, derived here
 * from the same three sources it derives them from - not copied as a
 * literal, which would go stale the moment a verb, a stem or a rule shape is
 * added and would then witness nothing. */
function expectedProtectionCount() {
  const registry = loadRegistry();
  const modules = registry.modules.map((entry) => entry.name);
  const families = new Set();
  for (const rule of buildRules(registry)) {
    const owner = modules.find((name) => rule.name.endsWith(`-${name}`));
    families.add(owner === undefined ? rule.name : rule.name.slice(0, -(owner.length + 1)));
  }
  return AUDIT_FORBIDDEN.length + P0_FORBIDDEN_TABLE_STEMS.length + families.size;
}

test("the coverage gate passes on this repository and reports what it checked", () => {
  const { code, out } = gate();
  assert.equal(code, 0, `the gate must pass on this repository; got:\n${out}`);
  assert.match(
    out,
    /COVERAGE_GATE PASS \d+ named protections, every one witnessed by a control/,
    `expected the gate's own PASS line; got:\n${out}`,
  );
  const expected = expectedProtectionCount();
  assert.match(
    out,
    new RegExp(`COVERAGE_GATE PASS ${expected} named protections`),
    `the gate must count every protection it names: ${expected} - the audit ` +
      `verbs, the P0 domain stems and the generated rule families together. A ` +
      `smaller count means one of those loops stopped running; no count at all ` +
      `means the gate returned before checking anything. It said:\n${out}`,
  );
});

test("the coverage gate refuses an audit verb no control asserts", () => {
  // AUDIT_FORBIDDEN's last entry, whatever it is, rather than a hard-coded
  // verb: this must keep witnessing the loop if the list is reordered.
  const verb = AUDIT_FORBIDDEN[AUDIT_FORBIDDEN.length - 1];
  const dir = testsDirWith((name, text) =>
    name === "migration-lint.test.mjs" ? text.split(`"${verb}" is refused`).join("(removed)") : text,
  );
  try {
    const { code, out } = gate({ COVERAGE_GATE_TEST_TESTS_DIR: dir });
    assert.equal(
      code,
      1,
      `a named protection with no control must FAIL the gate, not merely be ` +
        `mentioned by it; got ${code}:\n${out}`,
    );
    assert.ok(
      out.includes(`M3 refuses "${verb}" on the audit schema`),
      `expected the gate to name the unwitnessed verb; got:\n${out}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the coverage gate refuses a P0 domain stem no control asserts", () => {
  const { label } = P0_FORBIDDEN_TABLE_STEMS[P0_FORBIDDEN_TABLE_STEMS.length - 1];
  const dir = testsDirWith((name, text) =>
    name === "migration-lint.test.mjs"
      ? text.split(`the domain word "${label}"`).join("(removed)")
      : text,
  );
  try {
    const { code, out } = gate({ COVERAGE_GATE_TEST_TESTS_DIR: dir });
    assert.equal(code, 1, `got ${code}:\n${out}`);
    assert.ok(
      out.includes(`M4 refuses a table named for the domain word "${label}"`),
      `expected the gate to name the unwitnessed domain stem; got:\n${out}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the coverage gate refuses a generated rule family no control names", () => {
  // Rules 1 and 2 are generated per module and the boundary suite runs against
  // its own fixture registry, so the family - not the instance - is what must
  // be named. "rule-3-no-cycles" is a family with no per-module suffix, which
  // makes it the cleanest one to remove without also removing text some other
  // control needs.
  const family = "rule-3-no-cycles";
  const dir = testsDirWith((name, text) =>
    name === "boundary-rules.test.mjs" ? text.split(family).join("rule-3-removed") : text,
  );
  try {
    const { code, out } = gate({ COVERAGE_GATE_TEST_TESTS_DIR: dir });
    assert.equal(code, 1, `got ${code}:\n${out}`);
    assert.ok(
      out.includes(`${family} is a rule shape the generator emits`),
      `expected the gate to name the unwitnessed rule family; got:\n${out}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
