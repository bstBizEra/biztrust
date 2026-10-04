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

/**
 * The verbs M4 and M5 used to gate on ONE literal string, `target.verb !==
 * "CREATE TABLE"`. Round three open finding 8: `CREATE FOREIGN TABLE
 * tenancy.policies (...)` creates a P0 domain table with no tenant_id and
 * passed both rules, because a foreign table is a different verb from a
 * plain table but exactly as capable of holding tenant rows and being named
 * for a domain word.
 *
 * `objectTargets` already folds `CREATE MATERIALIZED VIEW` down to the verb
 * `CREATE VIEW` (the `MATERIALIZED` keyword is consumed as a modifier before
 * the captured object type, the same way `TEMP` and `UNLOGGED` are), so one
 * entry here covers both the plain and the materialized form; there is no
 * separate `CREATE MATERIALIZED VIEW` string this scanner ever produces.
 *
 * M5 DECISION, the open question this task was handed: does `tenant_id`
 * apply to a view? YES. A view has no columns of its OWN to add tenant_id
 * to, but it is still a queryable relation that can expose every row of a
 * tenant-owned table to a caller who never checked tenant_id, which is the
 * exact harm M5 exists to prevent - a view is the easiest way to launder a
 * bypass around it. The alternative was an exemption: treat a view as
 * out-of-scope for M5 by construction. That is the shape section 10 of this
 * task's constraints calls out by name - extending a list of known-safe
 * exceptions instead of inverting the default - and it is exactly how M4 and
 * M5 were defeated the first time: a rule that only fires for one recognised
 * shape is walked past by the next shape nobody enumerated. Requiring
 * `tenant_id` to appear in a view's own defining statement (its column list
 * or its SELECT) is satisfiable by any view that actually re-exposes the
 * column, so a conforming view costs one word, and an unwitnessed one is
 * refused rather than passed in silence.
 *
 * `SELECT ... INTO <target>` is here too, added by ruling on review of this
 * task: it creates a table exactly as `CREATE TABLE` does, as a side effect
 * of a query, and `objectTargets` already extracts it (verb `SELECT INTO`,
 * added in the round-three work that came before this task, for M1). Leaving
 * it out of this set would be the same hole M4 and M5 were built to close,
 * one call site over - a table-creating statement that these two rules never
 * look at because nobody added its verb to the list.
 */
export const TABLE_CREATING_VERBS = new Set([
  "CREATE TABLE",
  "CREATE FOREIGN TABLE",
  "CREATE VIEW",
  "SELECT INTO",
]);

/**
 * The word M4 and M5 use in their own messages for what was created, DERIVED
 * from the actual PostgreSQL keyword a target was resolved from rather than
 * hard-coded per verb string.
 *
 * The first version of this file (this task, first pass) hard-coded the
 * mapping as a per-verb-string lookup that defaulted to "table" for anything
 * it didn't recognise - which was correct only because `RENAME TO` was, at
 * the time, reachable solely through `ALTER TABLE`. Review of that pass
 * found the same defect this task exists to close, one call site over:
 * `ALTER VIEW ... RENAME TO` and `ALTER FOREIGN TABLE ... RENAME TO` are
 * both valid PostgreSQL for object types this very file treats as
 * table-creating, and the RENAME TO scan recognised only the literal keyword
 * `TABLE`, so neither was extracted as a target at all - M4 and M5 both
 * walked past a rename of exactly the kind this task was written to close.
 * Fixing the extraction (below) without fixing this label would then mislabel
 * a renamed view or foreign table as a "table" in its own violation message,
 * which is a defect in this project: every control asserts on the message.
 *
 * `relationKind` is the single source both the CREATE/ALTER/DROP scan and the
 * RENAME TO scan call with the raw keyword text they matched (`TABLE`,
 * `VIEW`, `FOREIGN TABLE`, `MATERIALIZED VIEW`), so a target's message word
 * is derived from what PostgreSQL actually calls it, not re-guessed from a
 * second list that has to be kept in step with the first by hand.
 */
function relationKind(typeKeyword) {
  const normalised = typeKeyword.toUpperCase().replace(/\s+/g, " ");
  if (normalised === "FOREIGN TABLE") return "foreign table";
  if (normalised === "VIEW" || normalised === "MATERIALIZED VIEW") return "view";
  return "table";
}

/**
 * The object types PostgreSQL allows `RENAME TO` on, as ONE alternation,
 * reused by the RENAME TO scan below. `FOREIGN\s+TABLE` and
 * `MATERIALIZED\s+VIEW` are ordered before their shorter substrings
 * (`TABLE`, `VIEW`) only for readability; JS regex alternation tries each in
 * order but the match position after `ALTER\s+` makes the two pairs mutually
 * exclusive in practice (`ALTER FOREIGN TABLE` cannot also start matching
 * plain `TABLE` at that position).
 *
 * This is deliberately the SAME shape as TABLE_CREATING_VERBS' four forms,
 * not a separately maintained, shorter list. Review of this task's first
 * pass found the RENAME TO scan hard-coded to the literal keyword `TABLE`
 * alone - an allow-list of one, extended from the finding this task closes
 * to a call site the same finding did not think to check. Deriving the
 * RENAME TO source from this alternation, instead of enumerating a longer
 * fixed list of keywords, means a future object type added to
 * TABLE_CREATING_VERBS' CREATE side and to this alternation together stays
 * symmetric by construction rather than by someone remembering to update
 * both.
 */
const RENAMEABLE_TYPES = String.raw`(FOREIGN\s+TABLE|MATERIALIZED\s+VIEW|VIEW|TABLE)`;

/**
 * Clauses that name another relation to READ from or structurally couple to,
 * as ONE list, not six separately maintained regexes.
 *
 * Round three open findings 9 and 10: `CREATE TABLE ... AS SELECT * FROM
 * audit.x`, `CREATE TABLE ... PARTITION OF audit.x` and `CREATE TABLE ...
 * INHERITS (audit.x)` all touch another module's schema exactly as
 * AGENTS.md section 5 forbids - the first by reading every row of it, the
 * other two by structurally coupling this table's own definition to it, a
 * tighter coupling than a foreign key - yet `objectTargets` only ever
 * resolved what a statement CREATES, ALTERS or DROPS. Nothing here read a
 * FROM, JOIN, USING, PARTITION OF, INHERITS or LIKE clause at all, so all
 * three linted clean, and so would a plain cross-schema JOIN in a report
 * view.
 *
 * `USING` is the DELETE ... USING / UPDATE ... FROM-equivalent table
 * reference, not the `JOIN t USING (col1, col2)` column-list form: the
 * pattern below requires a schema-qualified NAME, `(${ID})\.(${ID})`,
 * immediately after the keyword (through an optional `(` and `ONLY`), and a
 * parenthesised column list opens with `(` and a bare column name, never a
 * dot, so `USING (col1, col2)` never reaches the dot this pattern requires
 * and is left alone.
 *
 * Round four finding I4: the two structural-coupling clauses were closed in
 * CREATE position ONLY. `INHERITS (audit.x)` appears in a CREATE TABLE, but
 * the same coupling is made afterwards by `ALTER TABLE tenancy.notes INHERIT
 * audit.evidence` - `INHERIT`, singular, which the literal `INHERITS` entry
 * never matched - and `PARTITION OF` has a second spelling of its own in
 * `ALTER TABLE tenancy.notes ATTACH PARTITION audit.shard FOR VALUES IN (1)`.
 * Both linted clean. Both are closed HERE, in the one alternation this scan
 * already derives from, rather than by a second ALTER-shaped regex elsewhere
 * in the file: `INHERITS?` covers both spellings of the first, and
 * `ATTACH\s+PARTITION` is the second's own entry beside `PARTITION\s+OF`.
 *
 * Seven entries, seven independently deletable shapes: dropping any one of
 * them from this array is caught by that shape's own fixture, the same as
 * TABLE_CREATING_VERBS above.
 */
const CROSS_SCHEMA_READ_KEYWORDS = [
  "FROM",
  "JOIN",
  "USING",
  "PARTITION\\s+OF",
  "ATTACH\\s+PARTITION",
  "INHERITS?",
  "LIKE",
];

/** An identifier, bare or double-quoted. Both forms are legal PostgreSQL. */
const ID = String.raw`(?:"[^"]+"|[A-Za-z_]\w*)`;

/**
 * The positions where a schema-qualified name is a TYPE, as ONE alternation
 * of prefixes, the same shape CROSS_SCHEMA_READ_KEYWORDS above uses for
 * relation references.
 *
 * Round four finding I3: a column typed with ANOTHER module's type escaped
 * M1 entirely. `CREATE TABLE tenancy.t (code audit.status_code)` passed,
 * and the same line written `audit.status_code(10)` was caught only by
 * accident, as an EXPR CALL - the scan for a qualified name followed by
 * `(`, which cannot tell a typmod from a call and was never meant to read a
 * type at all. The CAST TYPE scan below already treats `::audit.mytype` as
 * reaching another module's schema; a type in DECLARATION position reaches
 * it at least as directly, because every row of the table now depends on
 * that type existing, not merely one expression.
 *
 * Each entry is a PREFIX consumed before the qualified name, and carries no
 * capturing group of its own, so the scan's own two groups stay the schema
 * and the type. Read in order: a column definition inside a relation's own
 * parenthesised list (`(` or `,`, a column name, then the type); a column
 * added afterwards; a column whose type is changed afterwards; a function
 * or procedure return type; and a domain's base type.
 *
 * Filtered against the module registry in the M1 loop below, exactly as
 * CAST TYPE is and for the same reason: `(id pg_catalog.int4)` names a
 * schema no module owns, which is not another MODULE's schema.
 */
const TYPE_POSITIONS = [
  String.raw`[(,]\s*${ID}\s+`,
  String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${ID}\s+`,
  String.raw`\bALTER\s+(?:COLUMN\s+)?${ID}\s+(?:SET\s+DATA\s+)?TYPE\s+`,
  String.raw`\bRETURNS\s+(?:SETOF\s+)?`,
  String.raw`\bCREATE\s+DOMAIN\s+(?:${ID}\.)?${ID}\s+AS\s+`,
];

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
    //
    // ASCII code is lower-cased before it is pushed. PostgreSQL folds every
    // UNQUOTED identifier to lower case (`AUDIT.decision` and `audit.decision`
    // name the same schema), and this is the same folding the quoted-identifier
    // branch above already applies to its own inner text - both branches now
    // normalise to the one case every comparison in this file assumes,
    // instead of each of M1's schema check, M2's foreign-key check and the
    // CREATE/DROP SCHEMA extraction separately guessing at case-insensitivity
    // on their own. An unquoted schema written `AUDIT`, `Audit` or `audit`
    // reaches every matcher identically, exactly as PostgreSQL itself would
    // resolve it - not just the schema position: an unquoted keyword folds
    // the same way in real PostgreSQL, so this is not a special case for
    // identifiers, it is what "every byte here is code, and code folds" means.
    // A non-ASCII byte is pushed UNCHANGED, same as before this change - it is
    // already refused by the `nonAscii` check below regardless of what this
    // branch does with it, so there is nothing to gain and a needless risk of
    // surprising `.toLowerCase()` behaviour on non-ASCII input to avoid.
    if (sql.codePointAt(i) > 127) {
      nonAscii.add(sql[i]);
      out.push(sql[i]);
    } else {
      out.push(sql[i].toLowerCase());
    }
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
 * There is NO list of harmless leading verbs, and the absence is the rule.
 *
 * Round three left exactly one entry here, `SET`, on the stated reasoning
 * that "a bare `SET <parameter> = <value>` changes a session setting, not an
 * object, so it cannot write into another module's schema", with
 * `SET search_path` called out as "the one exception ... refused by its own
 * explicit check below". Round four found that claim false, and found it
 * false in the worst possible way: PostgreSQL documents
 * `SET SCHEMA 'value'` as an alias for `SET search_path TO value`, and
 * `scrub()` blanks a string literal before any matcher runs, so
 * `SET SCHEMA 'audit';` reduced to `set schema ''`. The `SET SCHEMA`
 * extractor found no identifier to push, the search_path refusal found no
 * literal `search_path` to match, and `SET` sat on this list - so a file
 * opening with that one statement, and binding every unqualified name in
 * every statement after it into another module's schema, reported
 * `MIGRATION_LINT PASS` with exit 0. Note that the INVALID spelling
 * (`SET SCHEMA audit`, unquoted) was caught; only the legal one escaped.
 *
 * The fix is not a longer list of exceptions to a list of exemptions. It is
 * to delete the exemption: a statement this scanner resolves no target from
 * is refused, whatever verb it opens with, full stop. `SET` costs a
 * migration nothing - it can name its own schema explicitly on every object
 * instead - and the schema-resolution spellings get their own two explicit
 * refusals in `lintFile` besides, so the protection is a named rule rather
 * than an accident of what this scanner happens not to model.
 */

/**
 * Splits text on commas that are NOT nested inside parentheses.
 *
 * LOCK, ANALYZE and VACUUM each accept a comma-separated table list
 * (`LOCK a, b, c;`), and ANALYZE and VACUUM additionally allow a per-table
 * column list in parentheses (`ANALYZE t1 (col1, col2), t2;`), whose own
 * commas must NOT be treated as separators between tables. A naive
 * `text.split(",")` would read three targets out of that ANALYZE statement
 * instead of two, and would misreport `col2` as the second one.
 */
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Pushes one target for every item of a comma-separated table list such as
 * LOCK, ANALYZE and VACUUM all accept.
 *
 * A single-target regex anchored to one literal keyword occurrence is the
 * wrong shape for these three statements: `matchAll` resumes scanning after
 * the first match without re-anchoring on what follows, so
 * `LOCK a, b;` read only `a` and never even looked at `b`. A cross-schema
 * `b` in a table list after a same-schema `a` linted clean - a false
 * negative of exactly the kind this lint exists to close. Splitting the
 * whole tail on top-level commas first, then resolving one target per piece,
 * is what actually reads a list.
 *
 * Each item may carry a leading `ONLY`, a trailing `*`, or a trailing
 * per-table column list in parentheses; none of that is part of the
 * identifier, so only the leading `(schema.)?name` at the front of each
 * piece is read.
 */
function pushCommaSeparatedTargets(rest, verb, pushResolved) {
  const itemRe = new RegExp(String.raw`^\s*(?:ONLY\s+)?(${ID})(?:\.(${ID}))?`, "i");
  for (const item of splitTopLevelCommas(rest)) {
    const m = itemRe.exec(item);
    if (m === null) continue;
    if (m[2] === undefined) pushResolved(null, m[1], m[0], verb);
    else pushResolved(m[1], m[2], m[0], verb);
  }
}

/**
 * Every object a statement touches, and whether the lint understood it at all.
 *
 * Returns `{ targets, understood }`. `understood` is false when NOTHING here
 * resolved a target from the statement AND its leading verb is not on the
 * short harmless list above.
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
 *
 * Checkpoint declared_non_coverage item 7 widened that same hole: the
 * unrecognised-statement refusal only fired for a statement OPENING with
 * `CREATE`, `ALTER` or `DROP`, so `COPY`, `MERGE`, `REFRESH MATERIALIZED
 * VIEW`, `LOCK`, `ANALYZE`, `VACUUM`, `REINDEX`, `CLUSTER`, `GRANT`, `REVOKE`,
 * `COMMENT ON`, `SECURITY LABEL`, `IMPORT FOREIGN SCHEMA`, `SELECT ... INTO`
 * and `CALL` all linted clean regardless of what schema they touched. `COPY`
 * and `MERGE` in particular write rows into another module's schema - the
 * same act `INSERT INTO` is already modelled for. The opening-verb ALLOW-list
 * is replaced below by the HARMLESS_LEADING_VERBS DENY-list: every statement
 * this scanner does not resolve a target from is now refused, whatever verb
 * it opens with, unless that verb is provably incapable of crossing a schema.
 */
function objectTargets(statement) {
  const targets = [];

  // TWO push helpers, and the difference between them is round four finding
  // I2 (see the `understood` return below for the escape it produced).
  //
  //   pushResolved  the object this statement ACTS ON - creates, alters,
  //                 drops, renames, writes rows into, locks, refreshes.
  //                 Extracting one means this scanner RECOGNISED the
  //                 statement, so it also satisfies the deny-by-default
  //                 `understood` test.
  //   pushMention   a schema-qualified name the statement merely CARRIES -
  //                 a table it reads from or inherits, a function it calls
  //                 in an expression, a type it casts to or declares a
  //                 column with. Every one is still checked against M1 the
  //                 same way, but none of them is evidence that this
  //                 scanner understood the statement it sat inside.
  //
  // A new extractor picks one deliberately, and `pushMention` is the safe
  // default: mis-classifying a mention as resolved re-opens I2 (an
  // unmodelled statement passes because it happened to mention a name),
  // while mis-classifying a resolved target as a mention only costs an
  // extra, correct "cannot resolve what schema the statement touches"
  // refusal on a statement that is already being reported.
  //
  // `kind` is optional and only meaningful for a target M4/M5 will report on
  // (see relationKind above); every other call site below omits it and gets
  // `null`, which M4/M5 never read because they only reach a target whose
  // verb is in TABLE_CREATING_VERBS or is RENAME TO, and both of those push
  // sites always pass one. A mention never carries one at all.
  const pushResolved = (schema, object, text, verb, kind = null) =>
    targets.push({
      schema: schema ?? null,
      object: object ?? null,
      text,
      verb,
      kind,
      resolvesStatement: true,
    });
  const pushMention = (schema, object, text, verb) =>
    targets.push({
      schema: schema ?? null,
      object: object ?? null,
      text,
      verb,
      kind: null,
      resolvesStatement: false,
    });

  const scan = (re, handler) => {
    for (const match of statement.matchAll(re)) handler(match);
  };

  // CREATE SCHEMA x / DROP SCHEMA x. DROP was entirely unmodelled before.
  scan(
    new RegExp(String.raw`\b(CREATE|DROP)\s+SCHEMA\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(${ID})`, "gi"),
    (m) => pushResolved(m[2], null, m[0], `${m[1].toUpperCase()} SCHEMA`),
  );

  // ALTER <anything> SET SCHEMA <destination>. The DESTINATION is what matters:
  // it moves an object into another module's schema.
  scan(
    new RegExp(String.raw`\bSET\s+SCHEMA\s+(${ID})`, "gi"),
    (m) => pushResolved(m[1], null, m[0], "SET SCHEMA"),
  );

  // ALTER {TABLE|VIEW|FOREIGN TABLE|MATERIALIZED VIEW} [ONLY] [schema.]name
  // RENAME TO <destination>. Symmetric with SET SCHEMA above: the
  // DESTINATION is what matters. Round three open finding 8's second half:
  // `ALTER TABLE tenancy.neutral RENAME TO policies` creates the same P0
  // domain table `SET SCHEMA` creates a cross-schema write, in two
  // statements instead of one, because the rename destination was never
  // extracted as a target at all - so a table built under an innocent name
  // and renamed afterward walked past M4 with no violation anywhere in the
  // file. This task's own review then found the first fix recognised only
  // the literal keyword `TABLE`, so `ALTER VIEW ... RENAME TO` and
  // `ALTER FOREIGN TABLE ... RENAME TO` - both valid PostgreSQL for object
  // types this file treats as table-creating - reached the same unmodelled
  // place. RENAMEABLE_TYPES is the same four-form alternation
  // TABLE_CREATING_VERBS covers on the CREATE side, so a rename recognises
  // exactly what a create does. PostgreSQL's RENAME TO grammar carries no
  // schema of its own (a rename cannot cross schemas), so the destination
  // inherits the schema of the name being renamed, qualified or not; an
  // unqualified origin is already its own M1 finding on the base target
  // above; pushing the destination too, with the same (possibly absent)
  // schema, is what puts it in front of M1 and M4's per-target loops rather
  // than leaving it invisible to both. `kind` is derived from the matched
  // keyword itself (relationKind), not re-guessed from the verb string, so a
  // renamed view or foreign table reports as one in its own M4 message.
  scan(
    new RegExp(
      String.raw`\bALTER\s+${RENAMEABLE_TYPES}\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?(${ID})(?:\.(${ID}))?\s+RENAME\s+TO\s+(${ID})`,
      "gi",
    ),
    (m) => {
      const kind = relationKind(m[1]);
      if (m[3] === undefined) pushResolved(null, m[4], m[0], "RENAME TO", kind);
      else pushResolved(m[2], m[4], m[0], "RENAME TO", kind);
    },
  );

  // FROM|JOIN|USING|PARTITION OF|INHERITS|LIKE [ONLY] [schema.]name - see
  // CROSS_SCHEMA_READ_KEYWORDS above. Only the SCHEMA-QUALIFIED form is
  // matched (the pattern requires the literal `.`), so an ordinary
  // unqualified `FROM sometable` inside this module's own schema is left
  // alone; it is not new coverage this task closes, and re-flagging it here
  // would collide with the M1 "no schema qualifier" check above on the SAME
  // name for a reason unrelated to round three open findings 9 and 10.
  // Pushed through the same `push` every other scan here uses, with the
  // clause keyword itself as `verb` - a value TABLE_CREATING_VERBS and the
  // literal "RENAME TO" never contain, so M4 and M5 correctly never evaluate
  // a table this statement only reads from or inherits structure from, only
  // the ordinary M1 per-target "touches schema" check below does.
  scan(
    new RegExp(
      String.raw`\b(${CROSS_SCHEMA_READ_KEYWORDS.join("|")})\s*\(?\s*(?:ONLY\s+)?(${ID})\.(${ID})`,
      "gi",
    ),
    (m) => pushMention(m[2], m[3], m[0], m[1].toUpperCase().replace(/\s+/g, " ")),
  );

  // A schema-qualified CALL, anywhere in the statement - the review finding
  // on this same task: `DEFAULT audit.gen_uuid()` runs on every insert and
  // `CHECK (audit.is_valid_code(code))` runs on every insert and update,
  // structural coupling to another module's schema exactly as AGENTS.md
  // section 5 forbids, and nothing above ever looked INSIDE a column
  // DEFAULT or CHECK expression at all.
  //
  // DEFAULT and CHECK carry no clause-introducing keyword of their own the
  // way FROM or JOIN do - "DEFAULT" and "CHECK" are followed by an arbitrary
  // expression, not a name - so this cannot be two more entries appended to
  // CROSS_SCHEMA_READ_KEYWORDS above; there is no keyword there to anchor
  // on, and hand-listing "DEFAULT" and "CHECK" as a second, parallel context
  // list is exactly the one-shape-anchor constraint 10 warns against
  // (today it would be those two contexts; a GENERATED ALWAYS AS expression
  // or a trigger WHEN clause is the same shape and would need the same
  // treatment tomorrow). The generalisation is the fix, not a shortcut:
  // this scans for the SHAPE itself, `(${ID})\.(${ID})\s*\(` - a
  // schema-qualified name immediately followed by an opening parenthesis,
  // which is what a function or procedure CALL looks like in PostgreSQL
  // regardless of which clause it sits inside - rather than for a keyword
  // that precedes it.
  //
  // Pushed through `pushMention()` (see the two helpers above) and read by
  // the same M1 per-target
  // loop as every other scan here, so it is reported with the SAME "touches
  // schema" wording this file already uses everywhere else, not a new
  // "calls a function in" message that would need to be right about the
  // difference between a call and a declaration - `CREATE FUNCTION
  // audit.foo(...)` has exactly this textual shape and is not a call at
  // all, but "touches schema" is true of both, so the shared wording does
  // not need to tell them apart; a duplicate report on that exact statement
  // (once from the CREATE FUNCTION scan below, once from this one) is the
  // same accepted, harmless double-reporting already on record elsewhere in
  // this file (e.g. `VACUUM ANALYZE`, both scans correct about the same
  // schema and object).
  //
  // No exemption for an unregistered or built-in schema (pg_catalog,
  // public, an installed extension's own schema): this file has never
  // consulted the module registry to decide whether a FOREIGN schema
  // matters, only whether it EQUALS this directory's own schema, and this
  // scan follows that same rule rather than inventing a second one. See the
  // task report for what was tried before settling on this.
  //
  // Two other constructs share this exact textual shape without being a
  // call, found by re-review of this same task, and both are ruled out by
  // their own negative lookbehind rather than by narrowing the shape itself
  // (which would risk losing the DEFAULT/CHECK detection this scan exists
  // for):
  //
  //   - `'0'::pg_catalog.numeric(10,2)` - a schema-qualified TYPE CAST
  //     carrying a precision/scale/length modifier. Ordinary, legal
  //     PostgreSQL (`'x'::pg_catalog.varchar(255)`, `b'1'::pg_catalog.bit(8)`
  //     all cast to an unrelated schema's own built-in type), and nothing in
  //     `(${ID})\.(${ID})\s*\(` can tell that apart from a call - both are a
  //     qualified name immediately followed by `(`. A cast WITHOUT a
  //     modifier (`::pg_catalog.text`) already does not reach this scan at
  //     all, because there is no trailing `(` for the shape to match; only
  //     the typmod form does, and only the typmod form needs excluding.
  //     `(?<!::\s*)` rules out exactly that: a qualified name immediately
  //     preceded by the cast operator is a typmod, never a call.
  //   - `CREATE TABLE tenancy.policy (tenant_id uuid, ...)` - the relation's
  //     OWN column list, not a call to anything. The CREATE/ALTER/DROP scan
  //     below already extracts `tenancy.policy` as this statement's target
  //     (verb `CREATE TABLE`); this scan matching the identical text a
  //     second time is not the tolerated double-reporting recorded above for
  //     `CREATE FUNCTION audit.foo(...)` (a genuine call-shaped declaration)
  //     - it is this scan matching a construct it was never meant to match, a
  //     relation DEFINITION rather than an expression. The lookbehind reuses
  //     RENAMEABLE_TYPES - the same alternation of column-list-bearing
  //     relation types (TABLE, FOREIGN TABLE, VIEW, MATERIALIZED VIEW) this
  //     file already shares with the RENAME TO scan above - rather than a
  //     third, narrower, separately maintained list; its capturing group is
  //     turned non-capturing here (`(` -> `(?:`) so it does not shift `m[1]`/
  //     `m[2]` below, which still need to be the two ID groups.
  scan(
    new RegExp(
      String.raw`(?<!::\s*)(?<!\bCREATE\s+${MODIFIERS}${RENAMEABLE_TYPES.replace("(", "(?:")}\s+(?:IF\s+NOT\s+EXISTS\s+)?)\b(${ID})\.(${ID})\s*\(`,
      "gi",
    ),
    (m) => pushMention(m[1], m[2], m[0], "EXPR CALL"),
  );

  // A schema-qualified TYPE REFERENCE in CAST position - `::schema.name`,
  // with or without a trailing typmod argument list. Round two re-review of
  // this same task, a follow-up to finding 1 above: `(?<!::\s*)` correctly
  // stops treating a cast's typmod as a CALL, but by construction it also
  // made the cast itself undetectable as what it actually is - a reference
  // to another module's TYPE. Before this task, `'0'::audit.mytype(10)` was
  // misidentified as a call but happened to land on a true foreign-schema
  // positive; after the guard above, it went silent for every schema,
  // foreign included, and `::audit.mytype` with no typmod was never caught
  // either way, before or after. This scan closes both forms, which is why
  // it is strictly better than the incidental coverage the guard cost, not
  // merely a restoration of it.
  //
  // Unlike every other extractor in this file (see the EXPR CALL comment
  // above: "this file has never consulted the module registry"), THIS
  // scan's targets are filtered against the registry before M1 ever
  // reports on them (`knownSchemas`, threaded into `lintFile` from `main`,
  // read in the M1 per-target loop below): a schema no module owns -
  // `pg_catalog`, `information_schema`, an installed extension's own schema
  // - is not another MODULE's schema, and a cast to one of its built-in
  // types is exactly what finding 1 of the last round protected.
  // `pg_catalog.numeric(10,2)` must stay silent whether or not it carries a
  // typmod; only a cast to a schema some OTHER registered module actually
  // owns is the cross-module reference this scan exists to catch. Registry
  // membership, not a hand-maintained built-in-schema list: a second
  // parallel list of names to exempt is exactly the shape constraint 10
  // warns against, and the registry is already the one list this whole
  // file is generated from. `verb` is its own value, `"CAST TYPE"`, read by
  // its own branch in the M1 per-target loop rather than the shared
  // "touches schema" branch every other verb here falls into - that shared
  // branch has no registry to consult and must not gain one, or every
  // other extractor's existing "no exemption" stance changes with it.
  //
  // No trailing `\s*\(` requirement, unlike EXPR CALL: a type reference in
  // cast position is a reference whether or not it carries a typmod, so the
  // shape here is simply `::` immediately followed by a schema-qualified
  // name, nothing more. An array suffix (`::audit.mytype[]`,
  // `::audit.mytype(10)[]`) or anything else trailing the name is not part
  // of what this scan reads and does not need to be excluded - the
  // schema-qualified name is already fully captured before `[` or `(` would
  // appear, and neither one is required for a match.
  scan(new RegExp(String.raw`::\s*(${ID})\.(${ID})`, "gi"), (m) => pushMention(m[1], m[2], m[0], "CAST TYPE"));

  // A schema-qualified TYPE REFERENCE in DECLARATION position - see
  // TYPE_POSITIONS above for the five positions and for round four finding
  // I3, the escape this closes. Built from that one alternation of
  // prefixes rather than from five separate regexes, so a sixth position
  // is one array entry, and dropping any one of them is one mutation.
  // Pushed as a MENTION: a column's type is not the object the statement
  // acts on, so it must not satisfy the deny-by-default `understood` test
  // (finding I2, same round). Its own verb, `TYPE REF`, is read by the
  // registry-filtered branch of the M1 loop that CAST TYPE already uses.
  scan(
    new RegExp(
      String.raw`(?:${TYPE_POSITIONS.join("|")})(${ID})\.(${ID})`,
      "gi",
    ),
    (m) => pushMention(m[1], m[2], m[0], "TYPE REF"),
  );

  // CREATE|ALTER|DROP <TYPE> [schema.]name
  scan(
    new RegExp(
      String.raw`\b(CREATE|ALTER|DROP)\s+${MODIFIERS}(${NAMED_TYPES})\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(${ID})(?:\.(${ID}))?`,
      "gi",
    ),
    (m) => {
      const verb = `${m[1].toUpperCase()} ${m[2].toUpperCase().replace(/\s+/g, " ")}`;
      const kind = relationKind(m[2]);
      if (m[4] === undefined) pushResolved(null, m[3], m[0], verb, kind);
      else pushResolved(m[3], m[4], m[0], verb, kind);
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
      if (m[4] === undefined) pushResolved(null, m[3], m[0], verb);
      else pushResolved(m[3], m[4], m[0], verb);
    },
  );

  // Data manipulation.
  scan(
    new RegExp(
      String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(${ID})(?:\.(${ID}))?`,
      "gi",
    ),
    (m) => {
      if (m[2] === undefined) pushResolved(null, m[1], m[0], "DML");
      else pushResolved(m[1], m[2], m[0], "DML");
    },
  );

  // COPY <target> ... and MERGE INTO <target> ... . Checkpoint
  // declared_non_coverage item 7: both write rows into another module's
  // schema, the same act INSERT INTO is already modelled for above. `COPY
  // (query) TO ...` has no table target and is left unresolved on purpose -
  // it is refused as an unmodelled statement rather than guessed at.
  scan(new RegExp(String.raw`\bCOPY\s+(${ID})(?:\.(${ID}))?`, "gi"), (m) => {
    if (m[2] === undefined) pushResolved(null, m[1], m[0], "COPY");
    else pushResolved(m[1], m[2], m[0], "COPY");
  });
  scan(new RegExp(String.raw`\bMERGE\s+INTO\s+(${ID})(?:\.(${ID}))?`, "gi"), (m) => {
    if (m[2] === undefined) pushResolved(null, m[1], m[0], "MERGE INTO");
    else pushResolved(m[1], m[2], m[0], "MERGE INTO");
  });

  // REFRESH MATERIALIZED VIEW [CONCURRENTLY] <target>
  scan(
    new RegExp(
      String.raw`\bREFRESH\s+MATERIALIZED\s+VIEW\s+(?:CONCURRENTLY\s+)?(${ID})(?:\.(${ID}))?`,
      "gi",
    ),
    (m) => {
      if (m[2] === undefined) pushResolved(null, m[1], m[0], "REFRESH MATERIALIZED VIEW");
      else pushResolved(m[1], m[2], m[0], "REFRESH MATERIALIZED VIEW");
    },
  );

  // LOCK [TABLE] <target list> [IN lockmode MODE] [NOWAIT]. `name [, ...]`:
  // every table in the list is a target, not just the first, so the tail
  // after the modifiers is split on top-level commas rather than matched by
  // one anchored regex. `IN <lockmode> MODE` and `NOWAIT` are trailing
  // clauses, not table names, and are stripped before the split so neither
  // is mistaken for one.
  {
    const m = /\bLOCK\s+(?:TABLE\s+)?([\s\S]*)/i.exec(statement);
    if (m !== null) {
      const rest = m[1].replace(/\bIN\s+[\s\S]*?\bMODE\b/i, "").replace(/\bNOWAIT\b/i, "");
      pushCommaSeparatedTargets(rest, "LOCK", pushResolved);
    }
  }

  // ANALYZE [(options)] [VERBOSE] <target list> ; VACUUM [(options)|FULL|
  // FREEZE|VERBOSE|ANALYZE ...] <target list>. Both accept `table_and_columns
  // [, ...]` - a comma-separated list, each entry optionally followed by its
  // own parenthesised column list - so both go through the same top-level
  // comma split LOCK does, not a single anchored match.
  {
    const m = /\bANALYZE\s+(?:\([^)]*\)\s+)?(?:VERBOSE\s+)?([\s\S]*)/i.exec(statement);
    if (m !== null && m[1].trim() !== "") {
      pushCommaSeparatedTargets(m[1], "ANALYZE", pushResolved);
    }
  }
  {
    const m = /\bVACUUM\s+(?:\([^)]*\)\s+)?(?:(?:FULL|FREEZE|VERBOSE|ANALYZE)\s+)*([\s\S]*)/i.exec(
      statement,
    );
    if (m !== null && m[1].trim() !== "") {
      pushCommaSeparatedTargets(m[1], "VACUUM", pushResolved);
    }
  }

  // REINDEX [(options)] {INDEX|TABLE|SCHEMA|DATABASE|SYSTEM} [CONCURRENTLY] <target>
  scan(
    new RegExp(
      String.raw`\bREINDEX\s+(?:\([^)]*\)\s+)?(?:INDEX|TABLE|SCHEMA|DATABASE|SYSTEM)\s+(?:CONCURRENTLY\s+)?(${ID})(?:\.(${ID}))?`,
      "gi",
    ),
    (m) => {
      if (m[2] === undefined) pushResolved(null, m[1], m[0], "REINDEX");
      else pushResolved(m[1], m[2], m[0], "REINDEX");
    },
  );

  // CLUSTER [VERBOSE] <target> [USING index]
  scan(new RegExp(String.raw`\bCLUSTER\s+(?:VERBOSE\s+)?(${ID})(?:\.(${ID}))?`, "gi"), (m) => {
    if (m[2] === undefined) pushResolved(null, m[1], m[0], "CLUSTER");
    else pushResolved(m[1], m[2], m[0], "CLUSTER");
  });

  // SELECT ... INTO [TEMPORARY|TEMP|UNLOGGED] [TABLE] <target> - creates a
  // table as a side effect of a query, in whatever schema <target> names.
  // `INSERT INTO ... SELECT ...` is not this shape: INTO precedes SELECT
  // there, so it is left to the DML scan above rather than matched twice.
  scan(
    new RegExp(
      String.raw`\bSELECT\b.*?\bINTO\s+(?:TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?(?:TABLE\s+)?(${ID})(?:\.(${ID}))?`,
      "gi",
    ),
    (m) => {
      // Added to TABLE_CREATING_VERBS by ruling on review of this task: a
      // SELECT INTO always creates an ordinary table (never a view or a
      // foreign table), so its kind is not derived from a keyword the way
      // the other two table-creating scans' kinds are - there is only one
      // kind SELECT INTO can produce.
      if (m[2] === undefined) pushResolved(null, m[1], m[0], "SELECT INTO", "table");
      else pushResolved(m[1], m[2], m[0], "SELECT INTO", "table");
    },
  );

  // `understood` counts only targets pushed through `pushResolved` - the
  // object the statement ACTS ON - never one pushed through `pushMention`.
  // Round four finding I2: `understood` was `targets.length > 0`, and the
  // EXPR CALL and CAST TYPE scans push a target from any `schema.name(` or
  // `::schema.name` ANYWHERE in a statement, so an unmodelled statement that
  // merely contained an own-schema call shape stopped being refused.
  // `COMMENT ON TABLE tenancy.thing IS '...'` was refused, while
  // `COMMENT ON FUNCTION tenancy.f(uuid) IS '...'`,
  // `GRANT EXECUTE ON FUNCTION tenancy.f(uuid) TO PUBLIC` and
  // `SECURITY LABEL FOR provider ON FUNCTION tenancy.f(uuid) IS 'x'` all
  // passed - the deny-by-default that round three installed, undone by the
  // extractors round three's own later tasks added. An incidental mention is
  // not an understanding of the statement that carries it.
  return { targets, understood: targets.some((t) => t.resolvesStatement) };
}

function foreignKeyTargets(statement) {
  const out = [];
  const qualified = new RegExp(String.raw`\bREFERENCES\s+(${ID})\.(${ID})`, "gi");
  for (const m of statement.matchAll(qualified)) {
    out.push({ schema: m[1], object: m[2], text: m[0] });
  }
  // An unqualified REFERENCES cannot be proven same-schema by text alone.
  //
  // Round three open finding 10, second half: this branch used to require a
  // trailing `\s*\(`, i.e. an explicit referenced-column list, so
  // `REFERENCES othertable` with no column list at all - perfectly legal
  // PostgreSQL, meaning "the referenced table's primary key" - matched
  // nothing and escaped M2 entirely. The requirement is dropped; what stays
  // is the negative lookahead `(?![\w.])`, which is not the same guard doing
  // the same job by luck. It rules out two different things at once:
  //   - a dot immediately after, which means this is really a schema-
  //     qualified reference and belongs to the branch above, not this one
  //     (`REFERENCES tenancy.tenant (...)` must not also be reported here
  //     as unqualified "tenancy");
  //   - a WORD character immediately after, which rules out the bare `ID`
  //     alternative's `\w*` backtracking to a SHORTER match than the whole
  //     identifier so it can dodge the first bullet. `(?!\s*\.)` alone
  //     invites exactly that: faced with "tenancy.tenant", the engine
  //     happily matched only "tenanc" - one letter short - because "tenanc"
  //     is immediately followed by "y", not ".", so that narrower lookahead
  //     was satisfied. `(?![\w.])` forbids stopping mid-identifier at all,
  //     so the only length left that can satisfy it is the full identifier,
  //     and that length is exactly where the dot check correctly fires.
  const unqualified = new RegExp(String.raw`\bREFERENCES\s+(${ID})(?![\w.])`, "gi");
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

function lintFile(path, moduleName, schema, errors, knownSchemas) {
  const rel = relative(ROOT, path).replace(/\\/g, "/");
  const rawSql = readFileSync(path, "utf8");
  const report = (rule, detail) => errors.push(`${rel}: ${rule}: ${detail}`);

  // M1: a psql meta-command, a line whose first non-space character is `\`.
  // `\i ../../../elsewhere/drop.sql`, `\ir`, `\include` and the rest are not
  // SQL at all - they are executed directly by a psql-driven runner, and this
  // lint has no way to follow what they do, up to and including running a
  // second file this scan never reads. This is deliberately its OWN check
  // rather than left to the deny-by-default `understood` refusal below to
  // catch by accident: a `\i` line carries no SQL verb whatsoever, so relying
  // on the generic unmodelled-statement path to happen to also refuse it
  // would be an accident of that other rule's shape, not a rule of its own -
  // and a future change to that path's matching could stop catching it with
  // nothing here to notice. Each such line is stripped to blank before the
  // text reaches `statements()` below, so it is reported exactly once, by
  // this check, and not a second time as a generic unresolved statement.
  const metaCommandLines = [];
  const sql = rawSql
    .split(/\r?\n/)
    .map((line) => {
      if (!/^[ \t]*\\/.test(line)) return line;
      metaCommandLines.push(line.trim());
      return "";
    })
    .join(String.fromCharCode(10));
  for (const line of metaCommandLines) {
    report(
      "M1",
      `a psql meta-command ("${line}") is refused; a psql-driven runner executes ` +
        `this line directly, and this lint cannot see - let alone check - what it does`,
    );
  }

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
      } else if (target.verb === "CAST TYPE" || target.verb === "TYPE REF") {
        // Registry membership, not the plain inequality every other verb
        // here uses - see the CAST TYPE scan's comment in `objectTargets`.
        // A schema no module owns (pg_catalog, information_schema, an
        // installed extension's own schema) is silently not another
        // module's schema; only a cast reaching a schema some OTHER
        // registered module actually owns is reported.
        if (knownSchemas.has(target.schema) && target.schema !== schema) {
          report(
            "M1",
            (target.verb === "CAST TYPE"
              ? `casts to type "${target.schema}.${target.object}", a type in another ` +
                `module's schema (this directory owns "${schema}"); a cast reaches ` +
                `that schema's type exactly as directly as a foreign key reaches ` +
                `its table`
              : `references type "${target.schema}.${target.object}" in declaration ` +
                `position, a type in another module's schema (this directory owns ` +
                `"${schema}"); a type in declaration position reaches that schema ` +
                `at least as directly as a cast does`) + ` (${target.text.trim()})`,
          );
        }
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

    // M1, the SECOND spelling of the same act, and round four finding C1.
    // PostgreSQL documents `SET SCHEMA 'value'` as an alias for
    // `SET search_path TO value`. The check above never saw it: `scrub()`
    // blanks a string literal before any matcher runs, so the statement
    // reduced to `set schema ''` - no literal `search_path` for this check
    // to match, no identifier for the SET SCHEMA extractor to push, and
    // `SET` was on a list of leading verbs presumed harmless. The whole
    // file reported PASS. (The INVALID unquoted spelling, `SET SCHEMA
    // audit`, was caught all along; only the legal one escaped.)
    //
    // Anchored to the START of the statement on purpose: this is the
    // SESSION-level command. `ALTER TABLE tenancy.t SET SCHEMA audit` is a
    // different statement that moves one object, and the SET SCHEMA
    // extractor in objectTargets already resolves and reports it as a
    // target - reporting it here as well would say something false about
    // it. Written without reading the argument at all, so it holds for
    // every spelling of the value: quoted, unquoted, or blanked by scrub.
    if (/^\s*SET\s+(?:LOCAL\s+|SESSION\s+)?SCHEMA\b/i.test(statement)) {
      report(
        "M1",
        "sets the session schema; PostgreSQL documents \"SET SCHEMA 'value'\" as " +
          "an alias for \"SET search_path TO value\", so every unqualified name in " +
          "every statement after it binds somewhere this lint cannot predict",
      );
    }

    // M1, the THIRD spelling of the act the two checks above refuse, and
    // round four residual 2. `set_config('search_path', 'audit', false)`
    // IS `SET search_path TO audit`, written as a function call, and with
    // `is_local = false` it is session-scoped exactly as the statement form
    // is. Neither check above sees it: `scrub()` blanks the literal, so
    // there is no `search_path` token to match, and the session-SET check
    // is anchored to the start of a statement. Nor does deny-by-default,
    // once the call is wrapped in a statement whose own target resolves -
    // `INSERT INTO tenancy.probe (v) SELECT set_config('search_path',
    // 'audit', false);` resolved `tenancy.probe`, was understood, and the
    // whole file linted PASS with exit 0 while every unqualified name in
    // every statement after it bound into another module's schema.
    //
    // The refusal reads no argument, because it CANNOT: scrub() has
    // already blanked every string literal by the time any matcher runs,
    // so this lint cannot tell `set_config('search_path', ...)` from
    // `set_config('statement_timeout', ...)`. A parameter it cannot
    // identify is a refusal, not a guess - the same answer this file gives
    // a dollar-quoted body and a psql meta-command. `pg_catalog.set_config`
    // and any other schema-qualified spelling are covered by the same
    // pattern, since `.` is a non-word character and the `\b` holds after
    // it; a qualified spelling is additionally reported by the EXPR CALL
    // scan as touching that schema.
    if (/\bset_config\s*\(/i.test(statement)) {
      report(
        "M1",
        "calls set_config(), which sets a run-time parameter for the session; " +
          "set_config('search_path', 'audit', false) IS \"SET search_path TO " +
          "audit\" in function form. This lint blanks every string literal " +
          "before it reads a statement, so it cannot see WHICH parameter is " +
          "being set and refuses the call rather than guessing",
      );
    }

    // M1: a function or procedure body written as a SINGLE-QUOTED string
    // literal. `scrub()` blanks it to `''` exactly as it blanks any other
    // literal, so the body is as unreadable to this lint as a dollar-quoted
    // one - but the dollar-quoted refusal above counts only `$...$` bodies
    // and never saw this, the older and equally legal spelling. Whatever a
    // migration needs to do belongs in statements this lint can see.
    if (
      /\b(?:CREATE|ALTER)\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b[\s\S]*\bAS\s+''/i.test(
        statement,
      )
    ) {
      report(
        "M1",
        "a function or procedure body written as a single-quoted string literal " +
          "is refused; this lint cannot read one, exactly as it cannot read a " +
          "dollar-quoted body, and a body it cannot read is refused rather than " +
          "passed",
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
      // Round four finding I5: both sub-checks below were anchored to the
      // LITERAL keywords `ALTER TABLE`, so
      // `ALTER FOREIGN TABLE audit.evidence ALTER COLUMN amount TYPE numeric`
      // and the `ALTER MATERIALIZED VIEW` form both passed while the plain
      // `ALTER TABLE` spelling was refused - the same one-literal-keyword
      // defect this file already found and fixed twice, in the RENAME TO
      // scan and in M4/M5's verb gate, reproduced a third time in M3. This
      // file already carries the vocabulary for it: RENAMEABLE_TYPES is the
      // alternation of relation types TABLE_CREATING_VERBS covers on the
      // CREATE side and the RENAME TO scan reuses, so M3 now recognises
      // exactly the same set rather than a fourth, shorter one of its own.
      // AGENTS.md section 5 states the audit refusal absolutely; the lint
      // refuses the SHAPE, whether or not a given server would accept that
      // particular spelling, because a shape it cannot prove safe is a
      // refusal here, not a silence.
      const alterRelation = String.raw`\bALTER\s+${RENAMEABLE_TYPES}\b`;
      if (new RegExp(alterRelation + String.raw`[\s\S]*\bDROP\s+COLUMN\b`, "i").test(statement)) {
        report("M3", "a column drop is refused on the audit schema");
      }
      if (
        new RegExp(
          alterRelation +
            String.raw`[\s\S]*\b(?:ALTER\s+COLUMN\s+\w+\s+)?(?:SET\s+DATA\s+)?TYPE\b`,
          "i",
        ).test(statement)
      ) {
        report("M3", "a column type change is refused on the audit schema");
      }
    }

    // M4: no P0 table named for a domain word. Matched per underscore-separated
    // part against a STEM, so an English plural does not walk past the rule.
    for (const target of targets) {
      if (target.object === null) continue;
      // Keyed on the RESOLVED verb, not on re-testing the statement text. A
      // re-test for /CREATE\s+TABLE/ missed `CREATE TEMP TABLE policy`, because
      // the modifier sits between the two words. Gated on the SET of
      // table-creating verbs, not one literal string: a foreign table or a
      // view is exactly as able to be named for a domain word as a plain
      // table is. `RENAME TO` is not a CREATE verb but is checked here too -
      // its destination is the new name of an existing table, and that name
      // is exactly what this rule exists to catch.
      if (!TABLE_CREATING_VERBS.has(target.verb) && target.verb !== "RENAME TO") continue;
      for (const part of target.object.split("_")) {
        for (const { label, pattern } of P0_FORBIDDEN_TABLE_STEMS) {
          if (pattern.test(part)) {
            report(
              "M4",
              `${target.kind ?? "table"} "${target.object}" is named for the domain word ` +
                `"${label}"; P0 builds no domain table, and a table by this name means the ` +
                `phase has been left`,
            );
          }
        }
      }
    }

    // M5: a created table carries tenant_id, unless the statement that follows
    // the marker declares itself platform-owned. Gated on the same SET of
    // table-creating verbs as M4, not the one literal string this rule used
    // to check - see the M5 decision recorded on TABLE_CREATING_VERBS above
    // for why a view is included rather than exempted. `RENAME TO` is
    // deliberately NOT in this set: a rename statement carries no column
    // list and no SELECT, so checking it for the literal text "tenant_id"
    // would report every rename as a violation regardless of what the
    // renamed table already carries.
    const created = targets.find((t) => TABLE_CREATING_VERBS.has(t.verb));
    if (created && !/\btenant_id\b/i.test(statement)) {
      if (exemptStatements.has(statement)) {
        // Declared platform-owned. Nothing to report.
      } else {
        report(
          "M5",
          `${created.kind ?? "table"} "${created.object}" has no tenant_id column; every ` +
            `tenant-owned table carries the baseline of DOMAIN_MODEL.md section 6, ` +
            `tenant_id first. A platform-owned table that is genuinely not tenant-owned ` +
            `puts a "-- not-tenant-owned:" comment immediately before its own CREATE ` +
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

  // Every schema a registered module owns, as a SET rather than the
  // name-keyed Map above - the CAST TYPE scan's M1 branch (see its comment
  // in `objectTargets`) needs only membership, not which module owns which
  // schema. A schema no module owns (`pg_catalog`, `information_schema`, an
  // installed extension's own schema) is not in this set, which is exactly
  // how that branch tells "another module's schema" apart from "a built-in
  // schema no module claims" without a second, hand-maintained list of
  // built-in names.
  const knownSchemas = new Set(schemaOf.values());

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
      lintFile(path, entry, schema, errors, knownSchemas);
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
