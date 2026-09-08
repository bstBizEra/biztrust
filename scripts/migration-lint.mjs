#!/usr/bin/env node
/**
 * The migration lint: one schema per module, plus the protections that P0.10
 * and the security proof asked P0.2 to carry.
 *
 *   node scripts/migration-lint.mjs db/migrations
 *
 * The schema list is generated from `modules/modules.yaml`; a module that is
 * not registered cannot own a table, and a migration directory with no
 * registry row is itself a failure.
 *
 * No research names a tool that checks the objects of a migration against a
 * schema list, so this is a deterministic script in the pattern of the
 * continuity validator of the guide repository (P0.2 open question 5).
 *
 * It is a TEXT check over SQL, NOT a parser, and the difference is the honest
 * limit of this instrument. It normalises comments, string literals and
 * double-quoted identifiers first, refuses an unqualified object name, and
 * refuses a statement that sets search_path - the three ways peer review F1
 * found to walk past the earlier version. It still cannot see through a
 * dollar-quoted function body, a DO block, dynamic SQL built at runtime, or an
 * extension that creates objects as a side effect. Those are declared
 * non-coverage, recorded in the checkpoint, not silently tolerated.
 *
 * Rules
 *   M1  a migration under db/migrations/<module>/ touches only that schema
 *   M2  no foreign key crosses a schema boundary
 *   M3  the audit schema refuses UPDATE, DELETE, TRUNCATE, DROP, a column drop
 *       and a type change; a column add is allowed
 *   M4  in P0 no table is named for the four domain words the security proof
 *       lists: policy, client, claim, premium
 *   M5  every tenant-owned table carries tenant_id
 *   M6  every migration directory names a registered module
 *
 * Exit codes: 0 pass; 1 a data defect, the migrations are wrong; 2 a defect in
 * this script.
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, loadRegistry, RegistryError } from "./registry.mjs";

/**
 * The domain words P0 must not create a table for, as STEMS.
 *
 * Matched against each underscore-separated part of an object name, so
 * `policy`, `policies`, `policy_version` and `client_account` all hit. Peer
 * review F1 found `policies` slipping past a `policy(s)?` matcher, which is
 * the whole rule defeated by an English plural.
 */
const P0_FORBIDDEN_TABLE_STEMS = [
  { label: "policy", pattern: /^polic(y|ies)$/i },
  { label: "client", pattern: /^clients?$/i },
  { label: "claim", pattern: /^claims?$/i },
  { label: "premium", pattern: /^premiums?$/i },
];

/** Statements the audit schema refuses outright. */
const AUDIT_FORBIDDEN = ["UPDATE", "DELETE", "TRUNCATE", "DROP"];

/** An identifier, bare or double-quoted. Both forms are legal PostgreSQL. */
const ID = String.raw`(?:"[^"]+"|[A-Za-z_]\w*)`;

/**
 * Strips comments and string literals, and UNQUOTES double-quoted identifiers.
 *
 * The unquoting is not cosmetic. Peer review F1: every matcher here wanted a
 * bare identifier, so `CREATE TABLE "audit"."evidence"` - ordinary, legal SQL -
 * matched nothing at all and the file passed. The lint distinguished quoting
 * style rather than intent. Normalising first means one matcher covers both
 * spellings.
 *
 * Case folding is deliberate too: PostgreSQL folds an unquoted identifier to
 * lower case, so `POLICY` and `policy` are the same table.
 */
function scrub(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/"([^"]+)"/g, (_match, inner) => inner.toLowerCase())
    .replace(/\s+/g, " ");
}

function statements(sql) {
  return scrub(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const TABLE_VERBS = [
  { name: "CREATE TABLE", re: new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${ID})(?:\.(${ID}))?`, "gi") },
  { name: "ALTER TABLE", re: new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${ID})(?:\.(${ID}))?`, "gi") },
  { name: "DROP TABLE", re: new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${ID})(?:\.(${ID}))?`, "gi") },
  { name: "CREATE INDEX", re: new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\w*\s*ON\s+(${ID})(?:\.(${ID}))?`, "gi") },
  { name: "DML", re: new RegExp(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(${ID})(?:\.(${ID}))?`, "gi") },
];

const CREATE_SCHEMA = new RegExp(
  String.raw`\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(${ID})`,
  "gi",
);

/**
 * Every object a statement touches.
 *
 * `schema: null` means the name was UNQUALIFIED. That is a violation in its own
 * right, not a thing to skip: without a qualifier the object lands in whatever
 * `search_path` happens to be, which is exactly how a migration escapes its own
 * schema. The previous version had a comment saying an unqualified name is a
 * failure and no code that implemented it (peer review F1).
 */
function objectTargets(statement) {
  const targets = [];
  for (const { name, re } of TABLE_VERBS) {
    for (const match of statement.matchAll(re)) {
      const [text, first, second] = match;
      targets.push(
        second === undefined
          ? { schema: null, object: first, text, verb: name }
          : { schema: first, object: second, text, verb: name },
      );
    }
  }
  for (const match of statement.matchAll(CREATE_SCHEMA)) {
    targets.push({ schema: match[1], object: null, text: match[0], verb: "CREATE SCHEMA" });
  }
  return targets;
}

function foreignKeyTargets(statement) {
  const out = [];
  const qualified = new RegExp(String.raw`\bREFERENCES\s+(${ID})\.(${ID})`, "gi");
  for (const m of statement.matchAll(qualified)) {
    out.push({ schema: m[1], object: m[2], text: m[0] });
  }
  // An unqualified REFERENCES cannot be proven same-schema by text alone.
  const unqualified = new RegExp(String.raw`\bREFERENCES\s+(${ID})\s*\(`, "gi");
  for (const m of statement.matchAll(unqualified)) {
    if (!/\./.test(m[0])) out.push({ schema: null, object: m[1], text: m[0] });
  }
  return out;
}

function lintFile(path, moduleName, schema, errors) {
  const rel = relative(ROOT, path).replace(/\\/g, "/");
  const sql = readFileSync(path, "utf8");
  const report = (rule, detail) => errors.push(`${rel}: ${rule}: ${detail}`);

  for (const statement of statements(sql)) {
    // M1: every target is qualified, and names this module's schema.
    for (const target of objectTargets(statement)) {
      if (target.schema === null) {
        report(
          "M1",
          `${target.verb} names "${target.object}" with no schema qualifier; an ` +
            `unqualified name lands wherever search_path points, which is how a ` +
            `migration escapes its own schema. Write "${schema}.${target.object}".`,
        );
      } else if (target.schema !== schema) {
        report(
          "M1",
          `touches schema "${target.schema}" but this directory owns "${schema}" ` +
            `(${target.text.trim()})`,
        );
      }
    }

    // M1, second form: search_path is the other way to dodge qualification.
    // Setting it makes an unqualified name resolve somewhere this lint cannot
    // predict, so the statement is refused rather than analysed.
    if (/\bSET\s+(?:LOCAL\s+|SESSION\s+)?search_path\b/i.test(statement)) {
      report(
        "M1",
        "sets search_path; every object in a migration is named with an explicit " +
          "schema so that what it touches is readable without knowing the session state",
      );
    }

    // M2: no foreign key crosses a schema boundary.
    for (const fk of foreignKeyTargets(statement)) {
      if (fk.schema === null) {
        report("M2", `unqualified REFERENCES "${fk.object}"; qualify it with a schema`);
      } else if (fk.schema !== schema) {
        report(
          "M2",
          `foreign key from schema "${schema}" to "${fk.schema}.${fk.object}" crosses a ` +
            `schema boundary; reference the stable identifier instead`,
        );
      }
    }

    // M3: the audit schema is append-only.
    if (schema === "audit") {
      for (const verb of AUDIT_FORBIDDEN) {
        const re = new RegExp(`\\b${verb}\\b`, "i");
        if (re.test(statement)) {
          report("M3", `"${verb}" is refused on the audit schema (${statement.slice(0, 90)})`);
        }
      }
      if (/\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/i.test(statement)) {
        report("M3", "a column drop is refused on the audit schema");
      }
      if (/\bALTER\s+TABLE\b[\s\S]*\b(?:ALTER\s+COLUMN\s+\w+\s+)?(?:SET\s+DATA\s+)?TYPE\b/i.test(statement)) {
        report("M3", "a column type change is refused on the audit schema");
      }
    }

    // M4: no P0 table named for a domain word. Matched per underscore-separated
    // part against a STEM, so an English plural does not walk past the rule.
    for (const target of objectTargets(statement)) {
      if (target.object === null) continue;
      if (!/\bCREATE\s+TABLE\b/i.test(statement)) continue;
      for (const part of target.object.split("_")) {
        for (const { label, pattern } of P0_FORBIDDEN_TABLE_STEMS) {
          if (pattern.test(part)) {
            report(
              "M4",
              `table "${target.object}" is named for the domain word "${label}"; ` +
                `P0 builds no domain table, and a table by this name means the phase ` +
                `has been left`,
            );
          }
        }
      }
    }

    // M5: a created table carries tenant_id, unless it is registry metadata.
    const created = new RegExp(
      String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:${ID}\.)?(${ID})`,
      "i",
    ).exec(statement);
    if (created && !/\btenant_id\b/i.test(statement)) {
      report(
        "M5",
        `table "${created[1]}" has no tenant_id column; every tenant-owned table ` +
          `carries the baseline of DOMAIN_MODEL.md section 6, tenant_id first. ` +
          `A platform-owned table that is genuinely not tenant-owned records that ` +
          `with a "-- not-tenant-owned:" comment line, which this lint reads.`,
      );
    }
  }
}

/** Every *.sql under a directory, at any depth, in a stable order. */
function sqlFilesUnder(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".sql")) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function main() {
  const target = process.argv[2] ?? "db/migrations";
  const base = join(ROOT, target);
  let registry;
  try {
    registry = loadRegistry();
  } catch (error) {
    if (error instanceof RegistryError) {
      process.stderr.write(`MIGRATION_LINT FAIL ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const schemaOf = new Map(
    registry.modules.filter((m) => m.schema !== "none").map((m) => [m.name, m.schema]),
  );

  if (!existsSync(base)) {
    process.stdout.write(`MIGRATION_LINT PASS ${target} does not exist yet; nothing to lint\n`);
    return 0;
  }

  const errors = [];
  let files = 0;
  for (const entry of readdirSync(base)) {
    const dir = join(base, entry);
    if (!statSync(dir).isDirectory()) continue;

    // M6: a migration directory names a registered module.
    if (!schemaOf.has(entry)) {
      errors.push(
        `${relative(ROOT, dir).replace(/\\/g, "/")}: M6: no module named "${entry}" is ` +
          `registered in modules/modules.yaml, so it cannot own a schema`,
      );
      continue;
    }
    const schema = schemaOf.get(entry);
    // Recursive. Peer review F2: a flat readdir skipped
    // db/migrations/<module>/nested/*.sql entirely, reporting a lower file
    // count and passing. Most migration runners glob recursively, so a file
    // this lint never read would still be applied to the database.
    for (const path of sqlFilesUnder(dir)) {
      files += 1;
      // A file may declare that its table is platform-owned, not tenant-owned.
      const sql = readFileSync(path, "utf8");
      const exemptM5 = /^\s*--\s*not-tenant-owned:/m.test(sql);
      const before = errors.length;
      lintFile(path, entry, schema, errors);
      if (exemptM5) {
        for (let i = errors.length - 1; i >= before; i -= 1) {
          if (errors[i].includes(": M5: ")) errors.splice(i, 1);
        }
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`MIGRATION_LINT ${error}\n`);
    process.stderr.write(`MIGRATION_LINT FAIL ${errors.length} violation(s) in ${files} file(s)\n`);
    return 1;
  }
  process.stdout.write(`MIGRATION_LINT PASS ${files} file(s), no violation\n`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`MIGRATION_LINT FAIL lint defect: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
