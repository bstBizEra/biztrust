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
    match: 'touches schema "audit"',
  },
  {
    control: 5,
    threat: "a foreign key crosses a schema",
    file: "m2_foreign_key_crosses_a_schema.sql",
    rule: "M2",
    match: "crosses a schema boundary",
  },
  {
    control: 12,
    threat: "a mutation of an audit table",
    file: "m3_mutates_an_audit_table.sql",
    rule: "M3",
    match: '"DELETE" is refused',
  },
  {
    control: 12,
    threat: "a column drop on the audit schema",
    file: "m3_drops_a_column.sql",
    rule: "M3",
    match: "a column drop is refused",
  },
  {
    control: 11,
    threat: "a domain table in P0",
    file: "m4_domain_table_in_p0.sql",
    rule: "M4",
    match: 'table "policy" is named',
  },
  {
    control: 0,
    threat: "a tenant-owned table without tenant_id",
    file: "m5_table_without_tenant_id.sql",
    rule: "M5",
    match: "has no tenant_id column",
  },

  // Below: every input a peer review used to walk straight past this lint.
  // Each one passed silently before the quoting, qualification and plural
  // fixes. Each fixture carries exactly ONE violation shape, and each control
  // asserts on the MESSAGE, not just the rule name: mutation testing showed
  // that a file with two M4 violations proves nothing about either, because
  // disabling one still leaves the file reported.
  {
    control: 4,
    threat: "a double-quoted schema name writes outside its schema",
    file: "f1_quoted_schema.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: 11,
    threat: "a domain table name hidden behind double quotes",
    file: "f1_quoted_domain_table.sql",
    rule: "M4",
    match: 'table "policy" is named for the domain word "policy"',
  },
  {
    control: 11,
    threat: "a domain table name in the plural",
    file: "f1_plural_domain_table.sql",
    rule: "M4",
    match: 'table "policies" is named for the domain word "policy"',
  },
  {
    control: 5,
    threat: "a double-quoted foreign key crosses a schema",
    file: "f1_quoted_fk.sql",
    rule: "M2",
    match: 'to "audit.decision" crosses a schema boundary',
  },
  {
    control: 0,
    threat: "an object name with no schema qualifier",
    file: "f1_unqualified_table.sql",
    rule: "M1",
    match: "with no schema qualifier",
  },
  {
    control: 0,
    threat: "a migration that sets search_path",
    file: "f1_search_path.sql",
    rule: "M1",
    match: "sets search_path",
  },
  {
    control: 0,
    threat: "an unqualified REFERENCES",
    file: "ml3_unqualified_fk.sql",
    rule: "M2",
    match: "unqualified REFERENCES",
  },
  {
    control: 4,
    threat: "a migration in a nested directory",
    file: "nested/f2_nested.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: 12,
    threat: "a column type change on the audit schema",
    file: "m3_type_change.sql",
    rule: "M3",
    match: "a column type change is refused",
  },
  {
    control: 4,
    threat: "eight DDL verbs the lint did not model",
    file: "new2_unmodelled_verbs.sql",
    rule: "M1",
    match: "cannot resolve what schema the statement touches",
  },
  {
    control: 4,
    threat: "DROP SCHEMA against another module",
    file: "new2_unmodelled_verbs.sql",
    rule: "M1",
    match: "DROP SCHEMA audit",
  },
  {
    control: 4,
    threat: "moving an object into another schema with SET SCHEMA",
    file: "new2_unmodelled_verbs.sql",
    rule: "M1",
    match: "SET SCHEMA audit",
  },
  {
    control: 0,
    threat: "a not-tenant-owned marker leaking to a later table",
    file: "new_marker_leaks_to_later_tables.sql",
    rule: "M5",
    match: 'table "customer_data" has no tenant_id',
  },
  {
    control: 11,
    threat: "a domain word as a prefix of a longer name",
    file: "new_policyholder.sql",
    rule: "M4",
    match: 'table "policyholder" is named',
  },
  {
    control: 11,
    threat: "the plural of a second domain word",
    file: "new_plural_claims.sql",
    rule: "M4",
    match: 'table "claims" is named for the domain word "claim"',
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

for (const { control, threat, file, rule, match } of CONTROLS) {
  const label = control === 0 ? "baseline" : `control ${control}`;
  test(`${label}: ${threat} is reported as ${rule}`, () => {
    const lines = violating.out
      .split(/\r?\n/)
      .filter((line) => line.includes(file) && line.includes(`: ${rule}: `));
    assert.ok(
      lines.length > 0,
      `expected ${file} to be reported for ${rule}; the lint said:\n${violating.out}`,
    );
    // Asserting the rule NAME alone is not enough. A rule with more than one
    // violation shape reports the same name either way, so disabling the shape
    // under test leaves the file still reported and the control still green.
    // Mutation testing found exactly that: `M1: stop reporting an unqualified
    // object name` fell through to the else-branch and reported
    // `touches schema "null"`, which satisfied a name-only assertion.
    if (match !== undefined) {
      assert.ok(
        lines.some((line) => line.includes(match)),
        `${file} was reported for ${rule}, but not for the reason under test.\n` +
          `expected a message containing: ${match}\n` +
          `got:\n${lines.join("\n")}`,
      );
    }
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
