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

import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, loadRegistry, RegistryError } from "./registry.mjs";

/**
 * The domain words P0 must not create a table for, as STEMS.
 *
 * Matched as a PREFIX of each underscore-separated part of an object name, so
 * `policy`, `policies`, `policy_version`, `client_account`, `policyholder` and
 * `claimant` all hit.
 *
 * Two rounds of review shaped this. F1 found `policies` walking past a
 * `policy(s)?` matcher: the whole rule defeated by an English plural. A later
 * round found `policyholder` walking past the anchored stem, and asked for a
 * deliberate decision rather than an accident. The decision is prefix matching,
 * chosen knowing it also catches `clientele` and `claimant`.
 *
 * That breadth is correct here. P0 builds NO domain table at all, so a false
 * positive costs one conversation and a rename, while a false negative means
 * the phase boundary was crossed and nothing said so. The rule is scoped to P0
 * and is expected to be retired, not loosened, when the phase ends.
 */
export const P0_FORBIDDEN_TABLE_STEMS = [
  { label: "policy", pattern: /^polic(y|ies)/i },
  { label: "client", pattern: /^client/i },
  { label: "claim", pattern: /^claim/i },
  { label: "premium", pattern: /^premium/i },
];

/** Statements the audit schema refuses outright. */
export const AUDIT_FORBIDDEN = ["UPDATE", "DELETE", "TRUNCATE", "DROP"];

/** An identifier, bare or double-quoted. Both forms are legal PostgreSQL. */
const ID = String.raw`(?:"[^"]+"|[A-Za-z_]\w*)`;

/**
 * Strips comments and string literals, and UNQUOTES double-quoted identifiers,
 * in ONE left-to-right pass.
 *
 * The unquoting is not cosmetic. Peer review F1: every matcher here wanted a
 * bare identifier, so `CREATE TABLE "audit"."evidence"` - ordinary, legal SQL -
 * matched nothing at all and the file passed. The lint distinguished quoting
 * style rather than intent. Normalising first means one matcher covers both
 * spellings.
 *
 * The SINGLE pass is not cosmetic either, and it is the more important half.
 * This was four independent global `String.replace` passes until peer review
 * round three defeated the whole lint with one apostrophe. PostgreSQL allows
 * any character except `"` inside a quoted identifier, so `tenancy."o'brien"`
 * leaves a lone `'` - and the LITERAL pass, which ran first and scanned the
 * entire text, paired it with the next `'` further down the file and blanked
 * everything between. A migration could hide `DROP SCHEMA audit CASCADE`, a
 * cross-schema table and a P0 domain table between two such names and report
 * PASS with exit 0. Four protections failed open at once, on legal SQL.
 *
 * Every ordering of independent passes has some version of that bug, because
 * each pass reads text the others have not yet interpreted. A scanner that
 * consumes one construct from the current position does not, which is why the
 * shape here matters more than the cases it currently handles.
 *
 * Case folding is deliberate: PostgreSQL folds an unquoted identifier to lower
 * case, so `POLICY` and `policy` are the same table.
 *
 * Returns the scrubbed text together with what the scanner will NOT vouch for:
 * identifiers carrying anything outside `[A-Za-z0-9_]`, and dollar-quoted
 * bodies. The caller refuses both rather than normalising them away - an
 * identifier the matchers cannot represent, and a body this lint cannot read,
 * are refusals, not silence.
 */
function scrub(sql) {
  const out = [];
  const oddIdentifiers = [];
  const nonAscii = new Set();
  let dollarQuoted = 0;
  let i = 0;

  while (i < sql.length) {
    const pair = sql.slice(i, i + 2);

    if (pair === "--") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
      out.push(" ");
      continue;
    }

    if (pair === "/*") {
      // PostgreSQL block comments nest, so a depth counter and not an
      // end-marker search.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.slice(i, i + 2) === "/*") {
          depth += 1;
          i += 2;
        } else if (sql.slice(i, i + 2) === "*/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out.push(" ");
      continue;
    }

    if (sql[i] === "$") {
      const tag = /^\$\$|^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag !== null) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? sql.length : close + tag[0].length;
        dollarQuoted += 1;
        out.push(" '' ");
        continue;
      }
    }

    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] !== "'") {
          i += 1;
          continue;
        }
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      out.push(" '' ");
      continue;
    }

    if (sql[i] === '"') {
      i += 1;
      let inner = "";
      while (i < sql.length) {
        if (sql[i] !== '"') {
          inner += sql[i];
          i += 1;
          continue;
        }
        if (sql[i + 1] === '"') {
          inner += '"';
          i += 2;
          continue;
        }
        i += 1;
        break;
      }
      if (!/^[A-Za-z0-9_]+$/.test(inner)) oddIdentifiers.push(inner);
      out.push(inner.toLowerCase());
      continue;
    }

    // Outside a comment, a literal or a quoted identifier, every byte here is
    // code. A non-ASCII one is therefore part of an unquoted identifier, and
    // the ID pattern every matcher shares is ASCII-only: it stops at the first
    // such character. `tenancy.p<Cyrillic o>licy` resolved to `tenancy.p`,
    // which matches no domain stem, so a P0 `policy` table passed. The lint
    // read a different name than PostgreSQL would create, which is the one
    // thing it must never do quietly.
    if (sql.codePointAt(i) > 127) nonAscii.add(sql[i]);
    out.push(sql[i]);
    i += 1;
  }

  return {
    text: out.join("").replace(/\s+/g, " "),
    oddIdentifiers,
    nonAscii: [...nonAscii],
    dollarQuoted,
  };
}

function statements(sql) {
  const { text, oddIdentifiers, nonAscii, dollarQuoted } = scrub(sql);
  return {
    list: text
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
    oddIdentifiers,
    nonAscii,
    dollarQuoted,
  };
}

/** Noise words between a DDL verb and the object type. */
const MODIFIERS = String.raw`(?:(?:OR\s+REPLACE|GLOBAL|LOCAL|TEMP|TEMPORARY|UNLOGGED|MATERIALIZED|UNIQUE|RECURSIVE|CONSTRAINT)\s+)*`;

/** Object types whose name follows the type directly, optionally schema-qualified. */
const NAMED_TYPES = String.raw`(?:TABLE|VIEW|SEQUENCE|TYPE|DOMAIN|FUNCTION|PROCEDURE|ROUTINE|AGGREGATE|OPERATOR|COLLATION|CONVERSION|STATISTICS|FOREIGN\s+TABLE)`;

/** Object types whose SCHEMA comes from a trailing ON clause, not their own name. */
const ON_CLAUSE_TYPES = String.raw`(?:INDEX|TRIGGER|POLICY|RULE)`;

/**
 * Every object a statement touches, and whether the lint understood it at all.
 *
 * Returns `{ targets, understood }`. `understood` is false when a statement
 * begins with a DDL verb and NOTHING here resolved a target from it.
 *
 * `schema: null` means the name was UNQUALIFIED. That is a violation in its own
 * right: without a qualifier the object lands in whatever `search_path` happens
 * to be, which is how a migration escapes its own schema.
 *
 * DENY BY DEFAULT. Peer review NEW-2: the earlier version modelled TABLE and
 * SCHEMA and silently passed everything else, so `DROP SCHEMA audit CASCADE`,
 * `ALTER TABLE ... SET SCHEMA audit`, and CREATE VIEW / POLICY / TRIGGER /
 * SEQUENCE / TYPE / FUNCTION / MATERIALIZED VIEW against another module's
 * schema all linted clean. An unmodelled statement is now a failure rather than
 * a gap, which is what the docstring always should have meant by conservative.
 */
function objectTargets(statement) {
  const targets = [];
  const push = (schema, object, text, verb) =>
    targets.push({ schema: schema ?? null, object: object ?? null, text, verb });

  const scan = (re, handler) => {
    for (const match of statement.matchAll(re)) handler(match);
  };

  // CREATE SCHEMA x / DROP SCHEMA x. DROP was entirely unmodelled before.
  scan(
    new RegExp(String.raw`\b(CREATE|DROP)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(${ID})`, "gi"),
    (m) => push(m[2], null, m[0], `${m[1].toUpperCase()} SCHEMA`),
  );

  // ALTER <anything> SET SCHEMA <destination>. The DESTINATION is what matters:
  // it moves an object into another module's schema.
  scan(
    new RegExp(String.raw`\bSET\s+SCHEMA\s+(${ID})`, "gi"),
    (m) => push(m[1], null, m[0], "SET SCHEMA"),
  );

  // CREATE|ALTER|DROP <TYPE> [schema.]name
  scan(
    new RegExp(
      String.raw`\b(CREATE|ALTER|DROP)\s+${MODIFIERS}(${NAMED_TYPES})\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(${ID})(?:\.(${ID}))?`,
      "gi",
    ),
    (m) => {
      const verb = `${m[1].toUpperCase()} ${m[2].toUpperCase().replace(/\s+/g, " ")}`;
      if (m[4] === undefined) push(null, m[3], m[0], verb);
      else push(m[3], m[4], m[0], verb);
    },
  );

  // CREATE|ALTER|DROP INDEX|TRIGGER|POLICY|RULE <name> ON [schema.]table
  scan(
    new RegExp(
      String.raw`\b(CREATE|ALTER|DROP)\s+${MODIFIERS}(${ON_CLAUSE_TYPES})\s+(?:CONCURRENTLY\s+)?(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${ID}?\s*ON\s+(?:ONLY\s+)?(${ID})(?:\.(${ID}))?`,
      "gi",
    ),
    (m) => {
      const verb = `${m[1].toUpperCase()} ${m[2].toUpperCase()}`;
      if (m[4] === undefined) push(null, m[3], m[0], verb);
      else push(m[3], m[4], m[0], verb);
    },
  );

  // Data manipulation.
  scan(
    new RegExp(
      String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(${ID})(?:\.(${ID}))?`,
      "gi",
    ),
    (m) => {
      if (m[2] === undefined) push(null, m[1], m[0], "DML");
      else push(m[1], m[2], m[0], "DML");
    },
  );

  const isDDL = /^\s*(?:CREATE|ALTER|DROP)\b/i.test(statement);
  return { targets, understood: !isDDL || targets.length > 0 };
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

/**
 * The statements a `-- not-tenant-owned:` comment exempts from M5.
 *
 * The marker exempts the ONE statement that follows it and no other. A
 * file-wide marker let a legitimately platform-owned table at the top of a file
 * carry every later table past M5, including one holding customer columns and
 * no tenant_id.
 */
function exemptFromM5(sql) {
  const exempt = new Set();
  const lines = sql.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*--\s*not-tenant-owned:/.test(lines[i])) continue;
    // The marker exempts whatever statement comes next, up to the first
    // semicolon after it, and nothing beyond that.
    const [first] = statements(lines.slice(i + 1).join(String.fromCharCode(10))).list;
    if (first !== undefined) exempt.add(first);
  }
  return exempt;
}

function lintFile(path, moduleName, schema, errors) {
  const rel = relative(ROOT, path).replace(/\\/g, "/");
  const sql = readFileSync(path, "utf8");
  const report = (rule, detail) => errors.push(`${rel}: ${rule}: ${detail}`);
  const exemptStatements = exemptFromM5(sql);

  const { list, oddIdentifiers, nonAscii, dollarQuoted } = statements(sql);

  // M1, refusals the SCANNER raises rather than the matchers. Both are cases
  // where the lint knows it cannot represent what PostgreSQL will do, and the
  // round-three lesson is that the honest response to that is a refusal.
  for (const name of oddIdentifiers) {
    report(
      "M1",
      `the quoted identifier "${name}" carries a character outside ` +
        `[A-Za-z0-9_]; every matcher here is ASCII, so this lint would read a ` +
        `different name than PostgreSQL creates`,
    );
  }
  for (const character of nonAscii) {
    report(
      "M1",
      `an unquoted identifier carries the non-ASCII character "${character}"; ` +
        `the shared identifier pattern is ASCII and stops at it, so this lint ` +
        `reads a shorter name than PostgreSQL creates. A Cyrillic o in ` +
        `"policy" resolved to "p" and walked past the domain-word rule.`,
    );
  }
  if (dollarQuoted > 0) {
    report(
      "M1",
      `contains ${dollarQuoted} dollar-quoted body; this lint cannot read one, ` +
        `so it is refused rather than passed. Anything a migration needs to do ` +
        `belongs in statements this lint can see.`,
    );
  }

  for (const statement of list) {
    // M1: every target is qualified, and names this module's schema.
    const { targets, understood } = objectTargets(statement);

    // M1, deny by default. A DDL statement this lint cannot resolve to a target
    // is refused rather than passed. Eight ordinary statement types used to
    // sail through on silence, DROP SCHEMA among them.
    if (!understood) {
      report(
        "M1",
        `this lint cannot resolve what schema the statement touches, so it is ` +
          `refused rather than passed: ${statement.slice(0, 120)}`,
      );
    }

    for (const target of targets) {
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
    for (const target of targets) {
      if (target.object === null) continue;
      // Keyed on the RESOLVED verb, not on re-testing the statement text. A
      // re-test for /CREATE\s+TABLE/ missed `CREATE TEMP TABLE policy`, because
      // the modifier sits between the two words.
      if (target.verb !== "CREATE TABLE") continue;
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

    // M5: a created table carries tenant_id, unless the statement that follows
    // the marker declares itself platform-owned.
    const created = targets.find((t) => t.verb === "CREATE TABLE");
    if (created && !/\btenant_id\b/i.test(statement)) {
      if (exemptStatements.has(statement)) {
        // Declared platform-owned. Nothing to report.
      } else {
        report(
          "M5",
          `table "${created.object}" has no tenant_id column; every tenant-owned ` +
            `table carries the baseline of DOMAIN_MODEL.md section 6, tenant_id ` +
            `first. A platform-owned table that is genuinely not tenant-owned puts ` +
            `a "-- not-tenant-owned:" comment immediately before its own CREATE ` +
            `TABLE, which exempts that statement and no other.`,
        );
      }
    }
  }
}

/**
 * Every SQL file under a directory, at any depth, in a stable order, plus every
 * file that is NOT one.
 *
 * The extension test is case-insensitive. It was `entry.endsWith(".sql")`, and
 * peer review round three put `0001_evil.SQL` beside a clean `.sql` file: the
 * lint reported `1 file(s), no violation` and never opened the one carrying
 * `DROP SCHEMA audit CASCADE`. Windows and macOS filesystems do not distinguish
 * the two names at all, so on those hosts the runner and the lint disagreed
 * about which files exist.
 *
 * `others` exists because a file this lint SKIPS is the same failure as a file
 * it misreads, and the skip is quieter. The caller refuses them.
 */
function sqlFilesUnder(dir) {
  const found = [];
  const others = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.toLowerCase().endsWith(".sql")) found.push(full);
      else others.push(full);
    }
  };
  walk(dir);
  return { found, others };
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

    // M6, second form. A non-directory directly under the migrations root used
    // to be skipped in silence. Peer review round three put a file there
    // holding DROP SCHEMA audit CASCADE and the lint reported
    // "1 file(s), no violation": it had read only the file in the module
    // directory beside it. Every migration runner in the flat-layout style
    // would have applied the skipped one. A file the lint does not read is
    // refused, exactly as an unregistered directory is.
    if (!statSync(dir).isDirectory()) {
      errors.push(
        `${relative(ROOT, dir).replace(/\\/g, "/")}: M6: a migration must live in a ` +
          `directory named for the module that owns its schema; this file sits ` +
          `directly under the migrations root, where no module owns it and this ` +
          `lint would not read it`,
      );
      continue;
    }

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
    const { found, others } = sqlFilesUnder(dir);
    for (const path of others) {
      errors.push(
        `${relative(ROOT, path).replace(/\\/g, "/")}: M6: this lint reads only ` +
          `*.sql under a migration directory, so it would not read this file ` +
          `while a migration runner might. Remove it or give it a .sql name.`,
      );
    }
    for (const path of found) {
      files += 1;
      // The M5 exemption is per statement, resolved inside lintFile. It used
      // to be file-wide: one legitimately platform-owned table at the top
      // exempted every table below it in the same file, so a table with no
      // tenant_id could ride in behind it (peer review, minor finding).
      lintFile(path, entry, schema, errors);
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

// Run only when invoked as a command. The coverage gate imports the two
// lists above to ask which protections are named here and witnessed by no
// fixture, and an import that linted the repository as a side effect could
// not do that.
const invokedDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`MIGRATION_LINT FAIL lint defect: ${error?.stack ?? error}\n`);
    process.exitCode = 2;
  }
}
