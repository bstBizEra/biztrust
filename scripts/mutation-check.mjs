#!/usr/bin/env node
/**
 * The instrument that tests the instruments.
 *
 *   node scripts/mutation-check.mjs
 *
 * A test suite that passes whether or not the rule works is worth nothing, and
 * a green suite cannot tell you which of the two it is. This script loosens one
 * rule at a time, runs the boundary and migration suites, and requires the
 * suite to go RED. A mutation that SURVIVES names a rule that is not actually
 * enforced by any fixture.
 *
 * It exists because a peer review of `BIZTRUST-WP-001` did exactly this by
 * hand and found four loosenings the suite did not notice: rule 5 widened to
 * any `src/public/` file, rule 5 narrowed to internals only, rule 6 narrowed to
 * services, and rule 5b narrowed to modules. Every one of those would have
 * shipped a boundary that looked tested and was not. Running it by hand once
 * finds today's gaps; running it in CI keeps them found.
 *
 * Two mutations that SURVIVED on the second pass were not rule bugs but test
 * bugs: a fixture carrying two violations of the same rule proves neither,
 * because disabling one leaves the file still reported. The migration controls
 * now assert on the message, not just the rule name.
 *
 * Restores every file it touches, on success, on failure and on throw.
 *
 * Exit codes: 0 every mutation caught; 1 at least one survived; 2 the baseline
 * suite was not green to begin with, so the run proves nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./registry.mjs";

const RULES = join(ROOT, "scripts", "boundary-rules.mjs");
const LINT = join(ROOT, "scripts", "migration-lint.mjs");

/** Joins anchor lines, so no source string carries an embedded newline. */
const lines = (...parts) => parts.join("\n");

// A backtick and a dollar, spelled out. An anchor that quotes a template
// literal from the source cannot itself be a template literal: String.raw
// still interpolates ${...}, so the anchor would evaluate rather than match.
const BT = String.fromCharCode(96);
const DOLLAR = String.fromCharCode(36);

const MUTATIONS = [
  // ---- the dependency rules ----------------------------------------------
  {
    file: RULES,
    name: "rule 1: protect no module's internals",
    from: '      from: { pathNot: ' + BT + '^modules/' + DOLLAR + '{rx(m.name)}/' + BT + ' },',
    to: '      from: { pathNot: "^modules/" },',
  },
  {
    file: RULES,
    name: "rule 2: allow a cross-module import of any public file",
    from: '        pathNot: "^modules/[^/]+/src/public/index\\\\.ts$",',
    to: '        pathNot: "^modules/[^/]+/src/public/",',
  },
  {
    file: RULES,
    name: "rule 3: stop forbidding cycles",
    from: '    to: { circular: true },',
    to: '    to: { circular: false },',
  },
  {
    file: RULES,
    name: "rule 4: only the package named shared may not import a module",
    from: '    from: { path: "^packages/" },',
    to: '    from: { path: "^packages/shared/" },',
  },
  {
    file: RULES,
    name: "rule 5: allow an entry point to import any public file, not the contract",
    from: '      pathNot: "^modules/[^/]+/src/public/index\\\\.ts$",',
    to: '      pathNot: "^modules/[^/]+/src/public/",',
  },
  {
    file: RULES,
    name: "rule 5b: only a module may not import an entry point",
    from: '    from: { pathNot: "^(services|apps)/" },',
    to: '    from: { path: "^modules/" },',
  },
  {
    file: RULES,
    name: "rule 6: only a service may not import a test package",
    from: '    from: { pathNot: "^tests/" },',
    to: '    from: { path: "^services/" },',
  },
  {
    file: RULES,
    name: "rule 7: let the control plane call a module contract",
    from: '    from: { path: "^apps/control-plane/" },',
    to: '    from: { path: "^apps/nothing-matches-this/" },',
  },

  // ---- the migration lint -------------------------------------------------
  {
    file: LINT,
    name: "scrub: stop unquoting double-quoted identifiers",
    from: "      out.push(inner.toLowerCase());",
    to: "      out.push('\"' + inner + '\"');",
  },
  {
    file: LINT,
    // The rewrite below falls through to the `else if (target.schema !== schema)`
    // branch, which still reports M1 - with `touches schema "null"`. So this
    // mutation is caught by the control's MESSAGE assertion, not by the rule
    // continuing to fire. Round three found the old name claiming the opposite.
    name: "M1: report an unqualified name as a schema mismatch instead (message only)",
    from: '      if (target.schema === null) {',
    to: '      if (false) {',
  },
  {
    file: LINT,
    name: "M1: stop refusing search_path",
    from: '    if (/\\bSET\\s+(?:LOCAL\\s+|SESSION\\s+)?search_path\\b/i.test(statement)) {',
    to: '    if (false) {',
  },
  {
    file: LINT,
    name: "M1: stop denying by default on an unmodelled statement",
    from: '  return { targets, understood: harmless || targets.length > 0 };',
    to: '  return { targets, understood: true };',
  },
  {
    file: LINT,
    // Round three, checkpoint declared_non_coverage item 7: the old refusal
    // fired only when a statement OPENED with CREATE, ALTER or DROP, so COPY,
    // MERGE and every other verb outside that allow-list linted clean no
    // matter what schema they touched. Reverting to that allow-list must turn
    // the suite red by itself, independent of whether any target scan below
    // still runs.
    name: "M1: revert the deny-list to the old CREATE/ALTER/DROP opening-verb allow-list",
    from: '  const firstWord = /^\\s*([A-Za-z]+)/.exec(statement)?.[1]?.toUpperCase();\n  const harmless = firstWord !== undefined && HARMLESS_LEADING_VERBS.has(firstWord);\n  return { targets, understood: harmless || targets.length > 0 };',
    to: '  const isDDL = /^\\s*(?:CREATE|ALTER|DROP)\\b/i.test(statement);\n  return { targets, understood: !isDDL || targets.length > 0 };',
  },
  {
    file: LINT,
    name: "M1: stop modelling COPY as a target of the schema it writes into",
    from: '  scan(new RegExp(String.raw`\\bCOPY\\s+(${ID})(?:\\.(${ID}))?`, "gi"), (m) => {\n    if (m[2] === undefined) push(null, m[1], m[0], "COPY");\n    else push(m[1], m[2], m[0], "COPY");\n  });',
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling MERGE INTO as a target of the schema it writes into",
    from: '  scan(new RegExp(String.raw`\\bMERGE\\s+INTO\\s+(${ID})(?:\\.(${ID}))?`, "gi"), (m) => {\n    if (m[2] === undefined) push(null, m[1], m[0], "MERGE INTO");\n    else push(m[1], m[2], m[0], "MERGE INTO");\n  });',
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling REFRESH MATERIALIZED VIEW as a target of the schema it refreshes",
    from: "  scan(\n    new RegExp(\n      String.raw`\\bREFRESH\\s+MATERIALIZED\\s+VIEW\\s+(?:CONCURRENTLY\\s+)?(${ID})(?:\\.(${ID}))?`,\n      \"gi\",\n    ),\n    (m) => {\n      if (m[2] === undefined) push(null, m[1], m[0], \"REFRESH MATERIALIZED VIEW\");\n      else push(m[1], m[2], m[0], \"REFRESH MATERIALIZED VIEW\");\n    },\n  );",
    to: '  void 0;',
  },
  {
    file: LINT,
    // Review finding, CRITICAL: LOCK, ANALYZE and VACUUM each accept a
    // comma-separated table list, and the fixed code walks it with
    // pushCommaSeparatedTargets. This mutation reintroduces the exact
    // regression a text review caught: reading only the FIRST item of the
    // list and silently ignoring the rest, which is how a cross-schema table
    // listed after a same-schema one used to lint clean.
    name: "M1: LOCK reads only the first name in a comma-separated table list again",
    from: '      pushCommaSeparatedTargets(rest, "LOCK", push);',
    to: '      pushCommaSeparatedTargets(rest.split(",")[0], "LOCK", push);',
  },
  {
    file: LINT,
    name: "M1: ANALYZE reads only the first name in a comma-separated table list again",
    from: '      pushCommaSeparatedTargets(m[1], "ANALYZE", push);',
    to: '      pushCommaSeparatedTargets(m[1].split(",")[0], "ANALYZE", push);',
  },
  {
    file: LINT,
    name: "M1: VACUUM reads only the first name in a comma-separated table list again",
    from: '      pushCommaSeparatedTargets(m[1], "VACUUM", push);',
    to: '      pushCommaSeparatedTargets(m[1].split(",")[0], "VACUUM", push);',
  },
  {
    file: LINT,
    name: "M1: stop modelling REINDEX as a target of the schema it touches",
    from: "  scan(\n    new RegExp(\n      String.raw`\\bREINDEX\\s+(?:\\([^)]*\\)\\s+)?(?:INDEX|TABLE|SCHEMA|DATABASE|SYSTEM)\\s+(?:CONCURRENTLY\\s+)?(${ID})(?:\\.(${ID}))?`,\n      \"gi\",\n    ),\n    (m) => {\n      if (m[2] === undefined) push(null, m[1], m[0], \"REINDEX\");\n      else push(m[1], m[2], m[0], \"REINDEX\");\n    },\n  );",
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling CLUSTER as a target of the schema it touches",
    from: '  scan(new RegExp(String.raw`\\bCLUSTER\\s+(?:VERBOSE\\s+)?(${ID})(?:\\.(${ID}))?`, "gi"), (m) => {\n    if (m[2] === undefined) push(null, m[1], m[0], "CLUSTER");\n    else push(m[1], m[2], m[0], "CLUSTER");\n  });',
    to: '  void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling SELECT ... INTO as a target of the schema it creates a table in",
    from: '      if (m[2] === undefined) push(null, m[1], m[0], "SELECT INTO", "table");\n      else push(m[1], m[2], m[0], "SELECT INTO", "table");',
    to: '      void 0;',
  },
  {
    file: LINT,
    name: "M1: stop modelling CREATE SCHEMA and DROP SCHEMA",
    from: '    (m) => push(m[2], null, m[0], ' + BT + DOLLAR + '{m[1].toUpperCase()} SCHEMA' + BT + '),',
    to: '    () => {},',
  },
  {
    file: LINT,
    name: "M1: stop modelling ALTER ... SET SCHEMA",
    from: '    (m) => push(m[1], null, m[0], "SET SCHEMA"),',
    to: '    () => {},',
  },
  {
    file: LINT,
    name: "M2: drop the unqualified-REFERENCES half",
    from: '  for (const m of statement.matchAll(unqualified)) {',
    to: '  for (const m of []) {',
  },
  {
    file: LINT,
    name: "M3: stop refusing DELETE and DROP on the audit schema",
    from: 'const AUDIT_FORBIDDEN = ["UPDATE", "DELETE", "TRUNCATE", "DROP"];',
    to: 'const AUDIT_FORBIDDEN = ["UPDATE", "TRUNCATE"];',
  },
  {
    file: LINT,
    name: "M3: stop refusing an audit column drop (its own sub-check)",
    from: '        report("M3", "a column drop is refused on the audit schema");',
    to: '        void 0;',
  },
  {
    file: LINT,
    name: "M3: stop refusing an audit column type change (its own sub-check)",
    from: '        report("M3", "a column type change is refused on the audit schema");',
    to: '        void 0;',
  },
  {
    file: LINT,
    name: "M4: anchor the stems so a prefix like policyholder escapes",
    from: '  { label: "policy", pattern: /^polic(y|ies)/i },',
    to: '  { label: "policy", pattern: /^polic(y|ies)$/i },',
  },
  {
    file: LINT,
    name: "M4: revert to a matcher blind to the plural",
    from: '  { label: "claim", pattern: /^claim/i },',
    to: '  { label: "claim", pattern: /^claim$/i },',
  },

  // ---- round three open finding 8: M4/M5 gated on one verb -----------------
  {
    file: LINT,
    // Both M4 and M5 filter their targets through TABLE_CREATING_VERBS, so
    // dropping CREATE FOREIGN TABLE from the set turns both rules blind to a
    // foreign table at once; the R3-22 fixture (M4 on CREATE FOREIGN TABLE)
    // and R3-27 (M4 on ALTER FOREIGN TABLE ... RENAME TO, which is gated by
    // the same set membership check) both catch it.
    name: "M4/M5: drop CREATE FOREIGN TABLE from the table-creating verb set",
    from: '  "CREATE FOREIGN TABLE",\n',
    to: "",
  },
  {
    file: LINT,
    // Same set, the other CREATE-side entry from this task's first pass.
    // Caught by R3-24 (M4 on CREATE VIEW named for a domain word), R3-25 (M5
    // on a view with no tenant_id, the open-question decision this task
    // made), R3-26 (M4 on ALTER VIEW ... RENAME TO) and R3-28 (M4 on ALTER
    // MATERIALIZED VIEW ... RENAME TO, which folds to the same "VIEW" verb).
    name: "M4/M5: drop CREATE VIEW from the table-creating verb set",
    from: '  "CREATE VIEW",\n',
    to: "",
  },
  {
    file: LINT,
    // Added by ruling on review of this task, not the original brief: SELECT
    // ... INTO creates a table exactly as CREATE TABLE does. Caught by R3-29
    // (M4) and R3-30 (M5).
    name: "M4/M5: drop SELECT INTO from the table-creating verb set",
    from: '  "SELECT INTO",\n',
    to: "",
  },
  {
    file: LINT,
    // The rename destination stops becoming a target at all, for every
    // renameable object type: a table (or view, or foreign table) built
    // under an innocent name and renamed to a domain word afterward walks
    // past M4 again, exactly as it did before this task. Catches R3-23,
    // R3-26, R3-27 and R3-28 together.
    name: "M4: stop modelling ALTER ... RENAME TO as a target of the name it renames an object to",
    from: "  scan(\n    new RegExp(\n      String.raw`\\bALTER\\s+${RENAMEABLE_TYPES}\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${ID})(?:\\.(${ID}))?\\s+RENAME\\s+TO\\s+(${ID})`,\n      \"gi\",\n    ),\n    (m) => {\n      const kind = relationKind(m[1]);\n      if (m[3] === undefined) push(null, m[4], m[0], \"RENAME TO\", kind);\n      else push(m[2], m[4], m[0], \"RENAME TO\", kind);\n    },\n  );",
    to: "  void 0;",
  },
  {
    file: LINT,
    // Narrower than the mutation above: the scan still runs and the target
    // still exists, but M4's own filter stops accepting the RENAME TO verb,
    // so the target it produces is never checked against a domain stem.
    name: "M4: stop accepting RENAME TO as a verb this rule checks",
    from: '      if (!TABLE_CREATING_VERBS.has(target.verb) && target.verb !== "RENAME TO") continue;',
    to: "      if (!TABLE_CREATING_VERBS.has(target.verb)) continue;",
  },
  {
    file: LINT,
    // Round three review of this task's first pass, CRITICAL: the RENAME TO
    // scan recognised only the literal keyword TABLE, so ALTER VIEW / ALTER
    // FOREIGN TABLE / ALTER MATERIALIZED VIEW ... RENAME TO all walked past
    // M4 despite their CREATE forms being in TABLE_CREATING_VERBS. Narrowing
    // the alternation back to just TABLE reproduces that exact regression.
    // Catches R3-26, R3-27 and R3-28 (R3-23's plain-table rename still
    // matches TABLE alone, so it alone would not catch this).
    name: "M4: narrow the RENAME TO alternation back to the literal keyword TABLE",
    from: "const RENAMEABLE_TYPES = String.raw`(FOREIGN\\s+TABLE|MATERIALIZED\\s+VIEW|VIEW|TABLE)`;",
    to: "const RENAMEABLE_TYPES = String.raw`(TABLE)`;",
  },
  {
    file: LINT,
    // relationKind stops distinguishing a foreign table from a plain table,
    // so its M4/M5 message says "table" instead - a defect in this project,
    // since every control asserts on the message. Caught by R3-22 (CREATE
    // FOREIGN TABLE) and R3-27 (ALTER FOREIGN TABLE ... RENAME TO).
    name: "M4/M5: relationKind stops labelling a foreign table as one",
    from: '  if (normalised === "FOREIGN TABLE") return "foreign table";',
    to: "  if (false) return \"foreign table\";",
  },
  {
    file: LINT,
    // Same defect, the view/materialized-view half. Caught by R3-24, R3-25,
    // R3-26 and R3-28.
    name: "M4/M5: relationKind stops labelling a view as one",
    from: '  if (normalised === "VIEW" || normalised === "MATERIALIZED VIEW") return "view";',
    to: "  if (false) return \"view\";",
  },
  {
    file: LINT,
    name: "M5: stop requiring tenant_id",
    from: '    if (created && !/\\btenant_id\\b/i.test(statement)) {',
    to: '    if (false) {',
  },
  {
    file: LINT,
    name: "M5: make the not-tenant-owned marker file-wide again",
    from: '      if (exemptStatements.has(statement)) {',
    to: '      if (exemptStatements.size > 0) {',
  },
  {
    file: LINT,
    name: "M6: stop rejecting an unregistered migration directory",
    from: '    if (!schemaOf.has(entry)) {',
    to: '    if (false) {',
  },
  {
    file: LINT,
    name: "walk: revert to a non-recursive directory read",
    from: "      if (statSync(full).isDirectory()) walk(full);",
    to: "      if (statSync(full).isDirectory()) continue;",
  },
  {
    file: LINT,
    name: "scrub: blank literals in a separate pass, as before (the apostrophe hole)",
    from: '      if (!/^[A-Za-z0-9_]+$/.test(inner)) oddIdentifiers.push(inner);',
    to: "      if (false) oddIdentifiers.push(inner);",
  },
  {
    file: LINT,
    name: "scrub: stop refusing a non-ASCII character in an unquoted identifier",
    from: "    if (sql.codePointAt(i) > 127) nonAscii.add(sql[i]);",
    to: "    if (false) nonAscii.add(sql[i]);",
  },
  {
    file: LINT,
    name: "M1: stop refusing a dollar-quoted body",
    from: "  if (dollarQuoted > 0) {",
    to: "  if (false) {",
  },
  {
    file: LINT,
    name: "M6: skip a non-directory under the migrations root, as before",
    from: "    if (!statSync(dir).isDirectory()) {",
    to: "    if (!statSync(dir).isDirectory()) { continue; } if (false) {",
  },
  {
    file: LINT,
    name: "walk: match the .sql extension case-sensitively again",
    from: '      else if (entry.toLowerCase().endsWith(".sql")) found.push(full);',
    to: '      else if (entry.endsWith(".sql")) found.push(full);',
  },
  {
    file: LINT,
    name: "walk: stop reporting a file this lint would not read",
    from: "      else others.push(full);",
    to: "      else if (false) others.push(full);",
  },

  // ---- round three open findings 9 and 10: reads and structural coupling
  // across a schema boundary -------------------------------------------------
  //
  // CROSS_SCHEMA_READ_KEYWORDS is one alternation of six independently
  // deletable entries. Each mutation below drops exactly one, the same
  // pattern TABLE_CREATING_VERBS' per-entry mutations above use, and each is
  // caught by that one clause's own fixture (R3-31..R3-36) - not by any
  // other, so a mutation that drops JOIN and survives because FROM's fixture
  // still reports the file would be exactly the "message-shape coverage,
  // not extractor coverage" defect three earlier review rounds found.
  {
    file: LINT,
    name: "M1: stop treating FROM as a cross-schema read",
    from: '  "FROM",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating JOIN as a cross-schema read",
    from: '  "JOIN",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating USING as a cross-schema read",
    from: '  "USING",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating PARTITION OF as a cross-schema structural coupling",
    from: '  "PARTITION\\\\s+OF",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating INHERITS as a cross-schema structural coupling",
    from: '  "INHERITS",\n',
    to: "",
  },
  {
    file: LINT,
    name: "M1: stop treating LIKE as a cross-schema structural coupling",
    from: '  "LIKE",\n',
    to: "",
  },
  {
    file: LINT,
    // Round three open finding 10, first half: reverts exactly to the
    // pre-task regex, which required a trailing "(" - an explicit
    // referenced-column list - immediately after the referenced name, so
    // `REFERENCES othertable` with no column list at all matched nothing.
    // Caught by R3-37, not by the qualified branch above it (that branch
    // only ever fires on a schema-qualified REFERENCES, a different shape).
    name: "M2: require a column list again, so a bare REFERENCES escapes M2",
    from: 'const unqualified = new RegExp(String.raw`\\bREFERENCES\\s+(${ID})(?![\\w.])`, "gi");',
    to: 'const unqualified = new RegExp(String.raw`\\bREFERENCES\\s+(${ID})\\s*\\(`, "gi");',
  },
  {
    file: LINT,
    // A psql meta-command carries no SQL verb at all, so this is its own
    // check rather than left to the deny-by-default refusal to catch by
    // accident. Disabling it here still leaves the line refused by that
    // other, unrelated path (no target resolves from a line starting `\`),
    // but under the GENERIC "cannot resolve what schema the statement
    // touches" message, not "a psql meta-command" - R3-38 asserts the
    // specific message, not just that the file is refused at all, so this
    // mutation is caught by the message assertion even though the file
    // stays refused.
    name: "M1: stop refusing a psql meta-command as its own check",
    from: "      if (!/^[ \\t]*\\\\/.test(line)) return line;",
    to: "      if (true) return line;",
  },
];
function runSuite() {
  try {
    execFileSync(process.execPath, ["--test", "tests/boundaries/*.test.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return "GREEN";
  } catch {
    return "RED";
  }
}

function main() {
  if (runSuite() !== "GREEN") {
    process.stderr.write(
      "MUTATION_CHECK FAIL the baseline suite is not green, so this run proves " +
        "nothing. Fix the suite first.\n",
    );
    return 2;
  }
  process.stdout.write(`MUTATION_CHECK baseline GREEN, ${MUTATIONS.length} mutations\n`);

  const survived = [];
  const missing = [];

  for (const mutation of MUTATIONS) {
    const original = readFileSync(mutation.file, "utf8");
    if (!original.includes(mutation.from)) {
      // An anchor that no longer exists means the rule was rewritten and this
      // mutation silently stopped testing anything. That is a failure, not a
      // skip: it is the same "passes whether or not it works" defect one level
      // up.
      missing.push(mutation.name);
      continue;
    }
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to), "utf8");
    let result;
    try {
      result = runSuite();
    } finally {
      writeFileSync(mutation.file, original, "utf8");
    }
    if (result === "RED") {
      process.stdout.write(`  caught    ${mutation.name}\n`);
    } else {
      process.stdout.write(`  SURVIVED  ${mutation.name}\n`);
      survived.push(mutation.name);
    }
  }

  for (const name of missing) {
    process.stderr.write(`MUTATION_CHECK ANCHOR LOST ${name}\n`);
  }
  for (const name of survived) {
    process.stderr.write(`MUTATION_CHECK SURVIVED ${name}\n`);
  }

  if (survived.length > 0 || missing.length > 0) {
    process.stderr.write(
      `MUTATION_CHECK FAIL ${survived.length} mutation(s) survived, ` +
        `${missing.length} anchor(s) lost. A surviving mutation is a rule no ` +
        `fixture enforces; a lost anchor is a mutation that stopped testing.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `MUTATION_CHECK PASS ${MUTATIONS.length} mutations, every one caught\n`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`MUTATION_CHECK FAIL check defect: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
