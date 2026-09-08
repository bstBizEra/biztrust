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
    from: "  scan(\n    new RegExp(\n      String.raw`\\bSELECT\\b.*?\\bINTO\\s+(?:TEMPORARY\\s+|TEMP\\s+|UNLOGGED\\s+)?(?:TABLE\\s+)?(${ID})(?:\\.(${ID}))?`,\n      \"gi\",\n    ),\n    (m) => {\n      if (m[2] === undefined) push(null, m[1], m[0], \"SELECT INTO\");\n      else push(m[1], m[2], m[0], \"SELECT INTO\");\n    },\n  );",
    to: '  void 0;',
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
