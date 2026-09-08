/**
 * The boundary test suite.
 *
 * P0.2, "The boundary test suite": a fixture workspace holds one deliberately
 * violating import per rule and one conforming import per rule; this test runs
 * the checker over the fixture with the rules generated from a FIXTURE
 * registry, and asserts that each violating import is reported with the name of
 * its rule and each conforming one is not.
 *
 * The suite is what turns a one-time observation into a boundary that is
 * tested. It fails when a rule is loosened, when the generator drifts from the
 * registry, or when the output of the checker changes shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { parseRegistry, validateRegistry } from "../../scripts/registry.mjs";
import { buildRules } from "../../scripts/boundary-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FIXTURES = join(HERE, "fixtures");
const WORKSPACE = join(FIXTURES, "workspace");
// The CLI script is invoked with node rather than through the node_modules/.bin
// shim: on Windows the shim is a .cmd, and spawning one without a shell fails
// EINVAL under Node 24. This path is the same script the shim would run.
const DEPCRUISE = join(
  ROOT,
  "node_modules",
  "dependency-cruiser",
  "bin",
  "dependency-cruise.mjs",
);

/** Runs the checker over the fixture workspace and returns its violations. */
function cruiseFixture() {
  const registry = parseRegistry(readFileSync(join(FIXTURES, "modules.yaml"), "utf8"));
  const registryErrors = validateRegistry(registry);
  assert.deepEqual(registryErrors, [], "the fixture registry must itself be valid");

  const config = {
    forbidden: buildRules(registry),
    options: {
      doNotFollow: { path: "node_modules" },
      tsPreCompilationDeps: true,
      enhancedResolveOptions: { extensions: [".ts", ".js", ".mjs", ".cjs"] },
    },
  };

  const dir = mkdtempSync(join(tmpdir(), "biztrust-boundary-"));
  const configPath = join(dir, "fixture.dependency-cruiser.cjs");
  writeFileSync(configPath, `module.exports = ${JSON.stringify(config, null, 2)};\n`, "utf8");

  try {
    let stdout;
    try {
      stdout = execFileSync(
        process.execPath,
        [DEPCRUISE, "--config", configPath, "--output-type", "json", "modules", "packages", "services", "apps", "tests"],
        { cwd: WORKSPACE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      // A non-zero exit is EXPECTED: the fixture is built to violate. The
      // report is still on stdout, and an empty stdout is a real failure.
      stdout = error.stdout ?? "";
      assert.notEqual(stdout.trim(), "", `the checker produced no report: ${error.stderr ?? error}`);
    }
    return JSON.parse(stdout).summary.violations;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const violations = cruiseFixture();
const norm = (p) => String(p).replace(/\\/g, "/");
const firedFor = (file) =>
  violations.filter((v) => norm(v.from) === file).map((v) => v.rule.name);

/**
 * One row per line of the negative-controls table: the rule, the file built to
 * break it, and the rule name the checker must print.
 */
const CONTROLS = [
  {
    control: 1,
    threat: "a module reaches into the internals of another",
    file: "modules/beta/src/public/violates-rule-1.ts",
    rule: "rule-1-internals-private-alpha",
  },
  {
    control: 2,
    threat: "a cross-module import that is not the contract",
    file: "modules/beta/src/public/violates-rule-2.ts",
    rule: "rule-2-contracts-only-beta",
  },
  {
    control: 3,
    threat: "a cycle between two modules",
    file: "modules/cyc-one/src/public/index.ts",
    rule: "rule-3-no-cycles",
  },
  {
    control: 4,
    threat: "shared code reaching for domain code",
    file: "packages/shared/src/violates-rule-4.ts",
    rule: "rule-4-packages-import-no-module",
  },
  {
    control: 5,
    threat: "an entry point bypasses a contract",
    file: "services/api/src/violates-rule-5.ts",
    rule: "rule-5-entry-points-see-contracts-only",
  },
  {
    control: 6,
    threat: "something imports an entry point",
    file: "modules/beta/src/public/violates-rule-5b.ts",
    rule: "rule-5-nothing-imports-an-entry-point",
  },
  {
    control: 7,
    threat: "a test package reaches a shipping entry point",
    file: "services/api/src/violates-rule-6.ts",
    rule: "rule-6-test-packages-stay-in-tests",
  },
  {
    control: 8,
    threat: "the control plane calls a module contract in-process",
    file: "apps/control-plane/src/violates-rule-7.ts",
    rule: "rule-7-control-plane-sees-packages-only",
  },

  // The controls below exist because a peer review mutated each rule and found
  // four loosenings that the suite above did not notice. One fixture per rule
  // only proves the most obvious violating shape; these prove the rule's EDGE.
  // Each was confirmed to go red against its loosening before being kept.
  {
    control: 5,
    threat: "an entry point imports a module's public file that is not the contract",
    file: "services/api/src/violates-rule-5-public-not-contract.ts",
    rule: "rule-5-entry-points-see-contracts-only",
  },
  {
    control: 6,
    threat: "a package imports an entry point",
    file: "packages/shared/src/violates-rule-5b-from-a-package.ts",
    rule: "rule-5-nothing-imports-an-entry-point",
  },
  {
    control: 7,
    threat: "a module reaches the test-only bypass package",
    file: "modules/beta/src/public/violates-rule-6-from-a-module.ts",
    rule: "rule-6-test-packages-stay-in-tests",
  },
  {
    control: 7,
    threat: "a package reaches the test-only bypass package",
    file: "packages/shared/src/violates-rule-6-from-a-package.ts",
    rule: "rule-6-test-packages-stay-in-tests",
  },
  {
    control: 7,
    threat: "the control plane reaches the test-only bypass package",
    file: "apps/control-plane/src/violates-rule-6-from-the-control-plane.ts",
    rule: "rule-6-test-packages-stay-in-tests",
  },
  {
    control: 4,
    threat: "a second, differently named package reaches for domain code",
    file: "packages/second/src/violates-rule-4-second-package.ts",
    rule: "rule-4-packages-import-no-module",
  },
];

for (const { control, threat, file, rule } of CONTROLS) {
  test(`control ${control}: ${threat} is reported as ${rule}`, () => {
    const fired = firedFor(file);
    assert.ok(
      fired.includes(rule),
      `expected ${file} to be reported for ${rule}; the checker reported ` +
        (fired.length === 0 ? "nothing at all" : fired.join(", ")),
    );
  });
}

/** Each conforming import must be reported by nothing. */
const CONFORMING = [
  "packages/second/src/index.ts",
  "modules/alpha/src/public/index.ts",
  "modules/beta/src/public/index.ts",
  "packages/shared/src/index.ts",
  "services/api/src/index.ts",
  "apps/control-plane/src/index.ts",
];

for (const file of CONFORMING) {
  test(`conforming: ${file} is reported by no rule`, () => {
    assert.deepEqual(
      firedFor(file),
      [],
      `${file} conforms to every rule and must not be reported`,
    );
  });
}

test("every rule the generator produces is exercised or explicitly not", () => {
  const registry = parseRegistry(readFileSync(join(FIXTURES, "modules.yaml"), "utf8"));
  const generated = new Set(buildRules(registry).map((r) => r.name));
  const exercised = new Set(CONTROLS.map((c) => c.rule));

  // Rules 1 and 2 are generated per module, so the fixture exercises one
  // instance of each family rather than all four. Declared non-coverage.
  const families = ["rule-1-internals-private-", "rule-2-contracts-only-"];
  const unexercised = [...generated].filter(
    (name) => !exercised.has(name) && !families.some((f) => name.startsWith(f)),
  );

  assert.deepEqual(
    unexercised,
    [],
    `these rules are generated but no control exercises them: ${unexercised.join(", ")}`,
  );
});

test("the generated rule set is not empty and every rule is an error", () => {
  const registry = parseRegistry(readFileSync(join(FIXTURES, "modules.yaml"), "utf8"));
  const rules = buildRules(registry);
  assert.ok(rules.length >= 8, `expected at least 8 rules, built ${rules.length}`);
  for (const rule of rules) {
    assert.equal(
      rule.severity,
      "error",
      `${rule.name} is not severity error, so the checker would exit zero on it`,
    );
  }
});
