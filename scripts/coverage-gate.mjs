#!/usr/bin/env node
/**
 * The coverage gate: a protection this repository NAMES must be witnessed by a
 * fixture that asserts its own message.
 *
 *   node scripts/coverage-gate.mjs
 *
 * Three independent reviews of this repository found the same defect three
 * times, in three different instruments, and it was never that a rule was
 * wrong. It was that the SUITE WAS GREEN WHILE THE RULE DID NOTHING:
 *
 *   round one   four dependency rules could each be loosened with no fixture
 *               going red
 *   round two   two migration controls survived their own rule being disabled,
 *               because a fixture carrying two violations of one rule proves
 *               neither
 *   round three three of the four audit verbs and two of the four domain words
 *               had no fixture at all, and rule 5's apps/ arm had none either
 *
 * `scripts/mutation-check.mjs` answers "does this rule, as written, have a test
 * that fails when I break it?" - but only for the mutations someone thought to
 * list. This script answers the question one level up and without a list:
 * "is every protection this repository names witnessed by something?" It
 * derives the protections from the CODE - the audit verb list, the domain stem
 * list, the generated rule names - so adding a verb, a stem or a module without
 * a fixture fails the build rather than quietly widening the unwitnessed set.
 *
 * It is deliberately a text check over the test files. A test that names a
 * protection might still assert it weakly; that is what the mutation check is
 * for. What this catches is the case neither review could catch by reading:
 * a protection named nowhere in any assertion.
 *
 * Exit codes: 0 every named protection is witnessed; 1 one is not; 2 a defect
 * in this script.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadRegistry, RegistryError } from "./registry.mjs";
import { AUDIT_FORBIDDEN, P0_FORBIDDEN_TABLE_STEMS } from "./migration-lint.mjs";
import { buildRules } from "./boundary-rules.mjs";

const MIGRATION_TESTS = "tests/boundaries/migration-lint.test.mjs";
const BOUNDARY_TESTS = "tests/boundaries/boundary-rules.test.mjs";

function read(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

function main() {
  let registry;
  try {
    registry = loadRegistry();
  } catch (error) {
    if (error instanceof RegistryError) {
      process.stderr.write(`COVERAGE_GATE FAIL ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const migrationTests = read(MIGRATION_TESTS);
  const boundaryTests = read(BOUNDARY_TESTS);
  const unwitnessed = [];
  let checked = 0;

  // M3. AGENTS.md section 5: "The migration lint refuses UPDATE, DELETE,
  // TRUNCATE, DROP". Only DELETE had a fixture, so three quarters of that
  // sentence was unenforced by any test.
  for (const verb of AUDIT_FORBIDDEN) {
    checked += 1;
    if (!migrationTests.includes(`"${verb}" is refused`)) {
      unwitnessed.push(
        `M3 refuses "${verb}" on the audit schema, but no control in ` +
          `${MIGRATION_TESTS} asserts that message`,
      );
    }
  }

  // M4. Same sentence, same defect: `client` and `premium` were named in the
  // code and in the charter, and witnessed by nothing.
  for (const { label } of P0_FORBIDDEN_TABLE_STEMS) {
    checked += 1;
    if (!migrationTests.includes(`the domain word "${label}"`)) {
      unwitnessed.push(
        `M4 refuses a table named for the domain word "${label}", but no control ` +
          `in ${MIGRATION_TESTS} asserts that message`,
      );
    }
  }

  // The dependency rules, generated from the registry.
  //
  // Rules 1 and 2 are generated PER MODULE, and the boundary suite runs against
  // its own fixture registry, so `rule-1-internals-private-tenancy` correctly
  // appears in no test - the fixture witnesses `rule-1-internals-private-alpha`
  // instead. What must be witnessed is therefore the FAMILY: every distinct
  // rule shape the generator can emit. That one instance stands for four is a
  // declared non-coverage item, not a gap this gate can close, and pretending
  // otherwise would make the gate fail forever on a design decision.
  const modules = registry.modules.map((entry) => entry.name);
  const families = new Set();
  for (const rule of buildRules(registry)) {
    const owner = modules.find((name) => rule.name.endsWith(`-${name}`));
    families.add(owner === undefined ? rule.name : rule.name.slice(0, -(owner.length + 1)));
  }
  for (const family of [...families].sort()) {
    checked += 1;
    if (!boundaryTests.includes(family)) {
      unwitnessed.push(
        `${family} is a rule shape the generator emits from modules/modules.yaml, ` +
          `but no control in ${BOUNDARY_TESTS} names it`,
      );
    }
  }

  if (unwitnessed.length > 0) {
    for (const gap of unwitnessed) process.stderr.write(`COVERAGE_GATE ${gap}\n`);
    process.stderr.write(
      `COVERAGE_GATE FAIL ${unwitnessed.length} of ${checked} named protection(s) ` +
        `are witnessed by no fixture. A protection with no control is a sentence in ` +
        `a charter, not a mechanism.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `COVERAGE_GATE PASS ${checked} named protections, every one witnessed by a control\n`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`COVERAGE_GATE FAIL gate defect: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
