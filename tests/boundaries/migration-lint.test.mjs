/**
 * The migration lint suite.
 *
 * P0.2, "The boundary test suite": a second test runs the migration lint over
 * fixture migrations the same way the boundary suite runs the checker over the
 * fixture workspace. Each violating file must be reported by the rule it was
 * built to break; each conforming file must be reported by nothing.
 *
 * A fixture that passes the lint is itself a failure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const LINT = join(ROOT, "scripts", "migration-lint.mjs");

/** Runs the lint over a directory and returns { code, out }. */
function lint(relativeDir) {
  try {
    const stdout = execFileSync(process.execPath, [LINT, relativeDir], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return {
      code: error.status ?? -1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

const FIXTURES = "tests/boundaries/fixtures/migrations";

test("the conforming fixtures pass the lint", () => {
  const { code, out } = lint(`${FIXTURES}/conforming`);
  assert.equal(code, 0, `expected the conforming fixtures to pass; got:\n${out}`);
  assert.match(out, /MIGRATION_LINT PASS/);
});

const CONTROLS = [
  {
    control: 4,
    threat: "a migration writes outside its schema",
    file: "m1_writes_outside_its_schema.sql",
    rule: "M1",
  },
  {
    control: 5,
    threat: "a foreign key crosses a schema",
    file: "m2_foreign_key_crosses_a_schema.sql",
    rule: "M2",
  },
  {
    control: 12,
    threat: "a mutation of an audit table",
    file: "m3_mutates_an_audit_table.sql",
    rule: "M3",
  },
  {
    control: 12,
    threat: "a column drop on the audit schema",
    file: "m3_drops_a_column.sql",
    rule: "M3",
  },
  {
    control: 11,
    threat: "a domain table in P0",
    file: "m4_domain_table_in_p0.sql",
    rule: "M4",
  },
  {
    control: 0,
    threat: "a tenant-owned table without tenant_id",
    file: "m5_table_without_tenant_id.sql",
    rule: "M5",
  },
];

const violating = lint(`${FIXTURES}/violating`);

test("the violating fixtures fail the lint with exit code 1", () => {
  assert.equal(
    violating.code,
    1,
    `expected a data-defect exit of 1; got ${violating.code}:\n${violating.out}`,
  );
});

for (const { control, threat, file, rule } of CONTROLS) {
  const label = control === 0 ? "baseline" : `control ${control}`;
  test(`${label}: ${threat} is reported as ${rule}`, () => {
    const lines = violating.out
      .split(/\r?\n/)
      .filter((line) => line.includes(file) && line.includes(`: ${rule}: `));
    assert.ok(
      lines.length > 0,
      `expected ${file} to be reported for ${rule}; the lint said:\n${violating.out}`,
    );
  });
}

test("control 7 second form: a migration directory that names no registered module is reported as M6", () => {
  const lines = violating.out
    .split(/\r?\n/)
    .filter((line) => line.includes("not-a-module") && line.includes(": M6: "));
  assert.ok(
    lines.length > 0,
    `expected the unregistered directory to be reported for M6; the lint said:\n${violating.out}`,
  );
});

test("the real migrations under db/ pass the lint", () => {
  const { code, out } = lint("db/migrations");
  assert.equal(code, 0, `the repository's own migrations must pass; got:\n${out}`);
});
