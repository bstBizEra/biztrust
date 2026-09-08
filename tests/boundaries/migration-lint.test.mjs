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
  // Round three. The first of these is the one that mattered: the lint was a
  // no-op on a legal file, and the suite was green.
  {
    control: "R3-1",
    threat: "an apostrophe inside a double-quoted identifier",
    file: "r3_apostrophe_identifier.sql",
    rule: "M1",
    match: `the quoted identifier "o'brien" carries a character outside`,
  },
  {
    control: "R3-2",
    threat: "a non-ASCII character in an unquoted identifier",
    file: "r3_non_ascii_identifier.sql",
    rule: "M1",
    match: "an unquoted identifier carries the non-ASCII character",
  },
  {
    control: "R3-3",
    threat: "a dollar-quoted body this lint cannot read",
    file: "r3_dollar_quoted_body.sql",
    rule: "M1",
    match: "dollar-quoted body",
  },
  {
    control: "R3-4",
    threat: "a migration file directly under the migrations root",
    file: "r3_root_level.sql",
    rule: "M6",
    match: "sits directly under the migrations root",
  },
  {
    control: "R3-5",
    threat: "a file under a migration directory that this lint would not read",
    file: "r3_not_a_sql_file.txt",
    rule: "M6",
    match: "reads only *.sql under a migration directory",
  },

  // AGENTS.md section 5 names four verbs M3 refuses and four domain words M4
  // refuses. One verb and two words had a fixture; the rest were enforced by
  // code and witnessed by nothing, so each could be deleted with the suite
  // green. scripts/coverage-gate.mjs now asks for these by name, derived from
  // the lists in the lint itself rather than from a list kept beside them.
  {
    control: "R3-7",
    threat: "UPDATE on the audit schema",
    file: "m3_update.sql",
    rule: "M3",
    match: '"UPDATE" is refused',
  },
  {
    control: "R3-8",
    threat: "TRUNCATE on the audit schema",
    file: "m3_truncate.sql",
    rule: "M3",
    match: '"TRUNCATE" is refused',
  },
  {
    control: "R3-9",
    threat: "DROP on the audit schema",
    file: "m3_drop.sql",
    rule: "M3",
    match: '"DROP" is refused',
  },
  {
    control: "R3-10",
    threat: "the second P0 domain word",
    file: "m4_client.sql",
    rule: "M4",
    match: 'the domain word "client"',
  },
  {
    control: "R3-11",
    threat: "the fourth P0 domain word",
    file: "m4_premium.sql",
    rule: "M4",
    match: 'the domain word "premium"',
  },

  // Checkpoint declared_non_coverage item 7: deny-by-default triggered only
  // on a statement OPENING with CREATE, ALTER or DROP, so COPY, MERGE and
  // every other unmodelled verb linted clean regardless of what schema they
  // touched. COPY and MERGE INTO write rows into another module's schema,
  // the same act INSERT INTO is already modelled for; the third fixture below
  // is a verb this lint still does not model at all, now caught by the
  // inverted default rather than let through.
  {
    control: "R3-12",
    threat: "COPY writes rows into another module's schema",
    file: "r3_copy_into_audit.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: "R3-13",
    threat: "MERGE INTO writes rows into another module's schema",
    file: "r3_merge_into_audit.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: "R3-14",
    threat: "a statement opening with a verb this lint does not model at all",
    file: "r3_comment_unmodelled.sql",
    rule: "M1",
    match: "cannot resolve what schema the statement touches",
  },

  // Review of the above found two defects. CRITICAL: LOCK, ANALYZE and
  // VACUUM each accept a comma-separated table list, but the target regex
  // was anchored to one literal keyword occurrence, so only the FIRST name
  // in the list was ever checked - a cross-schema table listed after a
  // same-schema one linted clean. IMPORTANT: six of the eight new target
  // extractors (REFRESH MATERIALIZED VIEW, LOCK, ANALYZE, VACUUM, REINDEX,
  // CLUSTER, SELECT ... INTO) had no fixture at all, so each was
  // independently deletable with the suite staying green - message-shape
  // coverage (a shared "touches schema" string) is not the same as coverage
  // of the extractor that produced it, which is what let three earlier
  // review rounds pass with unenforced rules. One fixture per statement type
  // below; the LOCK/ANALYZE/VACUUM fixtures put the violation in the SECOND
  // list item on purpose, so a regression back to "only the first name is
  // checked" fails them.
  {
    control: "R3-15",
    threat: "REFRESH MATERIALIZED VIEW refreshes an object in another module's schema",
    file: "r3_refresh_materialized_view_audit.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: "R3-16",
    threat: "a table later in a LOCK list is in another module's schema",
    file: "r3_lock_list_second_item.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: "R3-17",
    threat: "a table later in an ANALYZE list is in another module's schema",
    file: "r3_analyze_list_second_item.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: "R3-18",
    threat: "a table later in a VACUUM list is in another module's schema",
    file: "r3_vacuum_list_second_item.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: "R3-19",
    threat: "REINDEX touches an object in another module's schema",
    file: "r3_reindex_audit.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: "R3-20",
    threat: "CLUSTER touches an object in another module's schema",
    file: "r3_cluster_audit.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },
  {
    control: "R3-21",
    threat: "SELECT ... INTO creates a table in another module's schema",
    file: "r3_select_into_audit.sql",
    rule: "M1",
    match: 'touches schema "audit"',
  },

  // Round three open finding 8: M4 and M5 gated on `target.verb !==
  // "CREATE TABLE"`, one literal string equality, so a P0 domain table with
  // no tenant_id created by any other table-creating verb walked past both
  // rules. Each verb below is independently deletable from
  // TABLE_CREATING_VERBS (or from the RENAME TO scan), so each gets its own
  // fixture and its own message assertion, not just a rule-name assertion.
  {
    control: "R3-22",
    threat: "CREATE FOREIGN TABLE creates a P0 domain table",
    file: "r3_foreign_table_domain_word.sql",
    rule: "M4",
    match: 'foreign table "claim" is named for the domain word "claim"',
  },
  {
    control: "R3-23",
    threat: "ALTER TABLE ... RENAME TO renames a table to a domain word",
    file: "r3_rename_to_domain_word.sql",
    rule: "M4",
    match: 'table "claim" is named for the domain word "claim"',
  },
  {
    control: "R3-24",
    threat: "CREATE VIEW creates a P0 domain-named relation",
    file: "r3_create_view_domain_word.sql",
    rule: "M4",
    match: 'view "policy" is named for the domain word "policy"',
  },
  // M5 decision for this task: a view is NOT exempt from tenant_id. See the
  // reasoning recorded on TABLE_CREATING_VERBS in scripts/migration-lint.mjs.
  {
    control: "R3-25",
    threat: "a view with no tenant_id",
    file: "r3_view_without_tenant_id.sql",
    rule: "M5",
    match: 'view "summary" has no tenant_id column',
  },

  // Review of the R3-22..25 pass above found the RENAME TO scan recognised
  // only the literal keyword TABLE, so ALTER VIEW / ALTER FOREIGN TABLE /
  // ALTER MATERIALIZED VIEW ... RENAME TO all walked past M4 despite their
  // CREATE forms being in TABLE_CREATING_VERBS - the exact finding this task
  // exists to close, reproduced one call site over. Each form of the
  // RENAMEABLE_TYPES alternation is independently deletable, so each gets
  // its own fixture and its own message assertion (including the "kind"
  // word, which is derived from the matched keyword and would silently say
  // "table" for a view or foreign table if that derivation regressed).
  {
    control: "R3-26",
    threat: "ALTER VIEW ... RENAME TO renames a view to a domain word",
    file: "r3_rename_view_domain_word.sql",
    rule: "M4",
    match: 'view "policy" is named for the domain word "policy"',
  },
  {
    control: "R3-27",
    threat: "ALTER FOREIGN TABLE ... RENAME TO renames a foreign table to a domain word",
    file: "r3_rename_foreign_table_domain_word.sql",
    rule: "M4",
    match: 'foreign table "claim" is named for the domain word "claim"',
  },
  {
    control: "R3-28",
    threat: "ALTER MATERIALIZED VIEW ... RENAME TO renames a materialized view to a domain word",
    file: "r3_rename_materialized_view_domain_word.sql",
    rule: "M4",
    match: 'view "premium" is named for the domain word "premium"',
  },

  // Added by ruling on review of this task (not in the original brief's verb
  // list): SELECT ... INTO creates a table exactly as CREATE TABLE does and
  // was left out of TABLE_CREATING_VERBS, the same class of escape this task
  // exists to close.
  {
    control: "R3-29",
    threat: "SELECT ... INTO creates a P0 domain table",
    file: "r3_select_into_domain_word.sql",
    rule: "M4",
    match: 'table "policy" is named for the domain word "policy"',
  },
  {
    control: "R3-30",
    threat: "SELECT ... INTO creates a table with no tenant_id",
    file: "r3_select_into_without_tenant_id.sql",
    rule: "M5",
    match: 'table "aggregate" has no tenant_id column',
  },

  // Round three open findings 9 and 10: a module that READS or structurally
  // COUPLES to another module's schema, rather than creating, altering or
  // dropping something in it, walked past this lint entirely - nothing here
  // ever looked at a FROM, JOIN, USING, PARTITION OF, INHERITS or LIKE
  // clause. CROSS_SCHEMA_READ_KEYWORDS is one alternation of six
  // independently deletable entries; each below proves one, with its own
  // fixture carrying exactly that one shape.
  {
    control: "R3-31",
    threat: "CREATE TABLE ... AS SELECT ... FROM reads another module's schema",
    file: "r3_from_reads_audit.sql",
    rule: "M1",
    match: 'touches schema "audit" but this directory owns "tenancy" (FROM audit.decision)',
  },
  {
    control: "R3-32",
    threat: "a JOIN reads another module's schema",
    file: "r3_join_reads_audit.sql",
    rule: "M1",
    match: 'touches schema "audit" but this directory owns "tenancy" (JOIN audit.decision)',
  },
  {
    control: "R3-33",
    threat: "DELETE ... USING reads another module's schema",
    file: "r3_using_reads_audit.sql",
    rule: "M1",
    match: 'touches schema "audit" but this directory owns "tenancy" (USING audit.decision)',
  },
  {
    control: "R3-34",
    threat: "PARTITION OF structurally couples to another module's schema",
    file: "r3_partition_of_audit.sql",
    rule: "M1",
    match: 'touches schema "audit" but this directory owns "tenancy" (PARTITION OF audit.decision)',
  },
  {
    control: "R3-35",
    threat: "INHERITS structurally couples to another module's schema",
    file: "r3_inherits_audit.sql",
    rule: "M1",
    match: 'touches schema "audit" but this directory owns "tenancy" (INHERITS (audit.decision)',
  },
  {
    control: "R3-36",
    threat: "LIKE copies column definitions from another module's schema",
    file: "r3_like_audit.sql",
    rule: "M1",
    match: 'touches schema "audit" but this directory owns "tenancy" (LIKE audit.decision)',
  },

  // Round three open finding 10, first half: the unqualified REFERENCES
  // branch of M2 required a trailing "(", so a foreign key with no column
  // list at all - legal PostgreSQL, meaning "the referenced table's primary
  // key" - matched nothing. ml3_unqualified_fk.sql always writes the column
  // list, so this is its own fixture.
  {
    control: "R3-37",
    threat: "an unqualified REFERENCES with no column list",
    file: "r3_unqualified_fk_no_column_list.sql",
    rule: "M2",
    match: 'unqualified REFERENCES "tenant"',
  },

  // A psql meta-command carries no SQL verb at all, so relying on the
  // deny-by-default unmodelled-statement refusal to catch it by accident
  // would be a different rule doing this one's job. This is its own check
  // and its own message.
  {
    control: "R3-38",
    threat: "a psql meta-command is refused outright",
    file: "r3_psql_meta_command.sql",
    rule: "M1",
    match: "a psql meta-command",
  },

  // Task 3 review, Important finding 1: a cross-schema reference in
  // EXPRESSION position - a schema-qualified function call inside a column
  // DEFAULT or CHECK - was invisible, because objectTargets only ever
  // inspected clause-introducing keywords, and DEFAULT/CHECK carry none of
  // their own. Two shapes, both fed by the SAME generalised scan (a
  // schema-qualified name immediately followed by "(", found anywhere in
  // the statement, not anchored to either keyword) - see the fix report for
  // why that is one rule, not two, and why it therefore has one mutation
  // witnessed by both fixtures below rather than two mutations pointed at
  // identical code.
  {
    control: "R3-39",
    threat: "a column DEFAULT calls a function in another module's schema",
    file: "r3_default_calls_audit_function.sql",
    rule: "M1",
    match: 'touches schema "audit" but this directory owns "tenancy" (audit.gen_uuid()',
  },
  {
    control: "R3-40",
    threat: "a CHECK constraint calls a function in another module's schema",
    file: "r3_check_calls_audit_function.sql",
    rule: "M1",
    match: 'touches schema "audit" but this directory owns "tenancy" (audit.is_valid_code()',
  },
];

// Control R3-6 is the inverse of the others: the fixture must be READ, not
// refused. An uppercase extension used to make the file invisible, so the
// evidence is that its CONTENT is reported.
test("control R3-6: a .SQL file is read despite the uppercase extension", () => {
  const lines = violating.out
    .split(/\r?\n/)
    .filter((line) => line.includes("r3_uppercase_extension.SQL"));
  assert.ok(
    lines.some((line) => line.includes(": M5: ")),
    `expected the uppercase-extension fixture to be read and reported for M5; ` +
      `the lint said:\n${violating.out}`,
  );
});

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
