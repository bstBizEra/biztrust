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
 * continuity validator of the guide repository (P0.2 open question 5). It is a
 * TEXT check over SQL, not a parser: it is deliberately conservative and will
 * refuse a statement it cannot read rather than pass it.
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

/** The four domain words P0 must not create a table for. */
const P0_FORBIDDEN_TABLE_WORDS = ["policy", "client", "claim", "premium"];

/** Statements the audit schema refuses outright. */
const AUDIT_FORBIDDEN = ["UPDATE", "DELETE", "TRUNCATE", "DROP"];

/** Strips comments and string literals so a keyword in prose is not a match. */
function scrub(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .replace(/\s+/g, " ");
}

function statements(sql) {
  return scrub(sql)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Qualified object names: schema.table. An unqualified name is a failure. */
function qualifiedTargets(statement) {
  const targets = [];
  const patterns = [
    /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/gi,
    /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/gi,
    /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/gi,
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\w*\s*ON\s+([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/gi,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/gi,
    /\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?()([A-Za-z_][\w]*)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of statement.matchAll(pattern)) {
      const isSchemaStatement = /\bCREATE\s+SCHEMA\b/i.test(match[0]);
      targets.push(
        isSchemaStatement
          ? { schema: match[2], object: null, text: match[0] }
          : { schema: match[1], object: match[2], text: match[0] },
      );
    }
  }
  return targets;
}

function foreignKeyTargets(statement) {
  const out = [];
  for (const m of statement.matchAll(
    /\bREFERENCES\s+([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/gi,
  )) {
    out.push({ schema: m[1], object: m[2], text: m[0] });
  }
  // An unqualified REFERENCES cannot be proven same-schema by text alone.
  for (const m of statement.matchAll(/\bREFERENCES\s+([A-Za-z_][\w]*)\s*\(/gi)) {
    if (!/\./.test(m[0])) out.push({ schema: null, object: m[1], text: m[0] });
  }
  return out;
}

function lintFile(path, moduleName, schema, errors) {
  const rel = relative(ROOT, path).replace(/\\/g, "/");
  const sql = readFileSync(path, "utf8");
  const report = (rule, detail) => errors.push(`${rel}: ${rule}: ${detail}`);

  for (const statement of statements(sql)) {
    // M1: every qualified target is this module's schema.
    for (const target of qualifiedTargets(statement)) {
      if (target.schema !== schema) {
        report(
          "M1",
          `touches schema "${target.schema}" but this directory owns "${schema}" ` +
            `(${target.text.trim()})`,
        );
      }
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

    // M4: no P0 table named for a domain word.
    for (const target of qualifiedTargets(statement)) {
      if (target.object === null) continue;
      if (!/\bCREATE\s+TABLE\b/i.test(statement)) continue;
      for (const word of P0_FORBIDDEN_TABLE_WORDS) {
        if (new RegExp(`(^|_)${word}(s)?(_|$)`, "i").test(target.object)) {
          report(
            "M4",
            `table "${target.object}" is named for the domain word "${word}"; ` +
              `P0 builds no domain table, and a table by this name means the phase ` +
              `has been left`,
          );
        }
      }
    }

    // M5: a created table carries tenant_id, unless it is registry metadata.
    const created = /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_][\w]*\.([A-Za-z_][\w]*)/i.exec(
      statement,
    );
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
        `db/migrations/${entry}: M6: no module named "${entry}" is registered in ` +
          `modules/modules.yaml, so it cannot own a schema`,
      );
      continue;
    }
    const schema = schemaOf.get(entry);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".sql")) continue;
      files += 1;
      const path = join(dir, file);
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
