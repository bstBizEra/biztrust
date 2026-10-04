/**
 * The seven dependency rules of the P0.2 design, built FROM a module registry.
 *
 * Separate from the generator so that the boundary test suite can build the
 * same rules from a FIXTURE registry and run the checker over a fixture
 * workspace. A suite that tested the generator against the real registry would
 * only prove the generator agrees with itself; the fixture holds one
 * deliberately violating import per rule and one conforming import per rule,
 * and asserts that each violation is reported with its rule name and each
 * conforming import is not.
 */

/** The directories under the repository root that hold first-party source. */
const SOURCE_ROOTS = ["modules", "packages", "services", "apps"];
const ROOTS = "(?:" + SOURCE_ROOTS.join("|") + ")";

/**
 * The paths the checker neither follows nor scans, each ANCHORED.
 *
 * Round ten, controls C10-1. dependency-cruiser tests `doNotFollow.path`
 * against each resolved path as a regular expression, and a module that
 * matches is not followed and is not picked up as a scan root. The old
 * pattern `node_modules|(^|/)dist/|...` matched any path that merely CONTAINED
 * the word, so a re-export in `services/api/src/node_modules-bridge.ts`, or any
 * file under a directory named `dist` at any depth, had its imports judged by
 * no rule while `boundaries:check` printed "no dependency violations". What is
 * left unfollowed is exactly this, and anything else is source and is followed,
 * whatever it is called:
 *
 *   thirdParty   the root node_modules, where pnpm puts every package
 *   linkFarm     a package's own node_modules: pnpm's symlinks. A workspace
 *                link there (`services/api/node_modules/@biztrust/audit`)
 *                is a SECOND PATH to a first-party file that rules 1 to 7 key
 *                on `^modules/...` and would judge as foreign, so it is not
 *                scanned; the file is cruised once, at its real path
 *   buildOutput  a package's dist/, one directory below a source root
 *   fixtures     the fixture tree, built to violate
 *
 * scripts/check-module-packages.mjs refuses a TRACKED file under the first
 * three, because that is the one way first-party source could sit where the
 * checker does not look.
 */
export const UNFOLLOWED = {
  thirdParty: "^node_modules/",
  linkFarm: "^" + ROOTS + "/[^/]+/node_modules/",
  buildOutput: "^" + ROOTS + "/[^/]+/dist/",
  fixtures: "^tests/boundaries/fixtures/",
};

/** The `doNotFollow.path` the generator writes. */
export const DO_NOT_FOLLOW = Object.values(UNFOLLOWED).join("|");

/** Escapes a module name for embedding in a regular expression literal. */
export function rx(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A word matched in either case, as regular expression source: `ab` is
 * `[aA][bB]`. dependency-cruiser compiles a `path` without flags, so the case
 * has to be written into the pattern.
 */
function caseless(word) {
  return [...word]
    .map((ch) => (/[A-Za-z]/.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : rx(ch)))
    .join("");
}

/** One hex digit of a percent escape, either case: `e` is `[eE]`. */
function hexDigit(digit) {
  return /[a-f]/.test(digit) ? `[${digit}${digit.toUpperCase()}]` : digit;
}

/**
 * A word matched in either case AND with any letter written as a percent
 * escape: `i` is `(?:[iI]|%69|%49)`.
 */
function loosely(word) {
  return [...word]
    .map((ch) => {
      const forms = new Set([ch.toLowerCase(), ch.toUpperCase()]);
      const codes = [...forms].map(
        (form) => "%" + [...form.charCodeAt(0).toString(16)].map(hexDigit).join(""),
      );
      return "(?:[" + [...forms].join("") + "]|" + codes.join("|") + ")";
    })
    .join("");
}

/**
 * A path separator as a specifier can spell it: a slash, a backslash, or
 * either one percent-encoded. Round nine, controls R9-m1: the rules matched
 * `/` only, so a specifier the runtime refuses but a reader would still call
 * an internals import was silent.
 */
const SEP = "(?:[/\\\\]|%2[fF]|%5[cC])";

/**
 * What may follow a directory name in a specifier: a separator, a query, a
 * hash, either one percent-encoded, or the end. `internal/x?q` was reported;
 * `internal?x` and `internal#x` were not.
 */
const END = "(?:" + SEP + "|[?#]|%3[fF]|%23|$)";

/**
 * The start of a by-name specifier, `@biztrust/`, in any case, with a dot
 * segment or a doubled separator allowed after the scope (`@biztrust/./audit`).
 */
const SCOPE = "^@" + caseless("biztrust") + SEP + "(?:\\." + SEP + "|" + SEP + ")*";

/**
 * The directory word, in any case and with percent escapes. Written into the
 * rule twice below rather than as an optional prefix: dependency-cruiser
 * refuses a pattern whose optional group holds a repetition (`(?:.*x)?`) as
 * unsafe, and accepts the same match written as an alternation.
 */
const INTERNAL = loosely("internal");

/** The specifiers that name `internal` anywhere under module `name`, however spelled. */
const internalByName = (name) =>
  SCOPE + caseless(name) + SEP + "(?:" + INTERNAL + "|.*" + SEP + INTERNAL + ")" + END;

export function buildRules(registry) {
  const packaged = registry.modules.filter((m) => m.package === true);
  const rules = [];
  // Every registered module, as one alternation. A deep import of a module by
  // package name, @biztrust/<module>/<path>, is refused by that package's
  // exports field, so the checker records it as unresolvable and a rule over
  // resolved paths never sees it. The by-name rules below match those.
  const anyModule = "(" + registry.modules.map((m) => caseless(m.name)).join("|") + ")";

  // Rule 1. A module's internals are private.
  for (const m of packaged) {
    rules.push({
      name: `rule-1-internals-private-${m.name}`,
      comment:
        `Rule 1: anything under modules/${m.name}/src/internal/, or the same ` +
        `directory built into dist/, may be imported ` +
        `only from inside modules/${m.name}/. The package exports field refuses ` +
        `the path at resolution as well; this rule catches an absolute path, ` +
        `against which exports "is not a strong encapsulation".`,
      severity: "error",
      from: { pathNot: `^modules/${rx(m.name)}/` },
      to: { path: `^modules/${rx(m.name)}/(?:src|dist)/internal/` },
    });
  }

  for (const m of packaged) {
    rules.push({
      name: `rule-1-internals-private-by-name-${m.name}`,
      comment:
        `Rule 1 by package name: @biztrust/${m.name}/src/internal/... from outside ` +
        `modules/${m.name}/, however the path is spelled (a .. or . segment, no ` +
        `trailing slash, other case, a percent escape, a backslash, a query or a ` +
        `hash). The exports field refuses it at resolution; this rule ` +
        `makes the refusal a named violation instead of a silent unresolved import.`,
      severity: "error",
      from: { pathNot: "^modules/" + rx(m.name) + "/" },
      // Any `internal` segment under the package, however the path is spelled.
      // The specifier is matched AS WRITTEN, not normalised, so
      // src/public/../internal/x, src/./internal/x and a bare src/internal
      // are all specifiers a literal `src/internal/` prefix never matches
      // (round seven, controls N1). Round nine, controls R9-m1: nor does it
      // match other case, a percent escape, a backslash, or a directory named
      // with a query or a hash and nothing after it.
      to: { couldNotResolve: true, path: internalByName(m.name) },
    });
  }

  // Rule 2. Modules depend on contracts.
  for (const m of packaged) {
    rules.push({
      name: `rule-2-contracts-only-${m.name}`,
      comment:
        `Rule 2: modules/${m.name} may import another module only through ` +
        `@biztrust/<module>, which resolves to that module's contract, ` +
        `src/public/index.ts. Never a repository, a table or a connection, and ` +
        `never the built copy of one under dist/.`,
      severity: "error",
      from: { path: `^modules/${rx(m.name)}/` },
      to: {
        path: "^modules/(?!" + rx(m.name) + "/)[^/]+/(?:src|dist)/",
        pathNot: "^modules/[^/]+/src/public/index\\.ts$",
      },
    });
  }

  for (const m of packaged) {
    rules.push({
      name: `rule-2-contracts-only-by-name-${m.name}`,
      comment:
        `Rule 2 by package name: modules/${m.name} imports another module by a ` +
        `deep path, @biztrust/<module>/<path>, instead of its bare contract.`,
      severity: "error",
      from: { path: `^modules/${rx(m.name)}/` },
      to: {
        couldNotResolve: true,
        path: SCOPE + "(?!" + caseless(m.name) + SEP + ")" + anyModule + SEP + ".+",
      },
    });
  }

  // Rule 3. No cycles.
  rules.push({
    name: "rule-3-no-cycles",
    comment:
      "Rule 3: the module dependency graph is acyclic. A pair of modules that " +
      "need each other is one module or a missing contract.",
    severity: "error",
    from: { path: "^modules/" },
    to: { circular: true },
  });

  // Rule 4. Shared code is not domain code.
  rules.push({
    name: "rule-4-packages-import-no-module",
    comment:
      "Rule 4: packages/* may be imported by any module and may import no " +
      "module. A package that needs a module's type has found domain code in " +
      "the wrong place.",
    severity: "error",
    from: { path: "^packages/" },
    to: { path: "^modules/" },
  });

  // Rule 5. Entry points and experiences see contracts only, and nothing
  // imports an entry point or an experience.
  rules.push({
    name: "rule-5-entry-points-see-contracts-only",
    comment:
      "Rule 5: services/* and apps/* import modules' contracts and packages/*; " +
      "an import of any other path inside a module, src/ or built dist/, is a " +
      "bypass of the contract.",
    severity: "error",
    from: { path: "^(services|apps)/" },
    to: {
      path: "^modules/[^/]+/(?:src|dist)/",
      pathNot: "^modules/[^/]+/src/public/index\\.ts$",
    },
  });
  rules.push({
    name: "rule-5-nothing-imports-an-entry-point",
    comment: "Rule 5, second half: nothing imports services/* or apps/*.",
    severity: "error",
    from: { pathNot: "^(services|apps)/" },
    to: { path: "^(services|apps)/" },
  });

  rules.push({
    name: "rule-5-entry-points-see-contracts-only-by-name",
    comment:
      "Rule 5 by package name: services/* and apps/* import a module by a deep " +
      "path, @biztrust/<module>/<path>, which bypasses its contract.",
    severity: "error",
    from: { path: "^(apps|services)/" },
    to: { couldNotResolve: true, path: SCOPE + anyModule + SEP + ".+" },
  });

  // Rule 6. Test packages stay in tests.
  rules.push({
    name: "rule-6-test-packages-stay-in-tests",
    comment:
      "Rule 6: anything under tests/ may be imported only from tests/. The rule " +
      "exists so that the P0.7 bypass entry point, a test-only package that runs " +
      "a statement as the application role with no authorization, cannot reach a " +
      "running service.",
    severity: "error",
    from: { pathNot: "^tests/" },
    to: { path: "^tests/" },
  });

  // Rule 7. The control plane sees packages only.
  rules.push({
    name: "rule-7-control-plane-sees-packages-only",
    comment:
      "Rule 7: apps/control-plane imports packages/* and no module's contract, " +
      "narrower than rule 5, because a contract call runs in the calling process " +
      "and would pass the P0.3 chain, the P0.4 resolver and the audit by. The " +
      "surface reaches the platform through the admin API alone.",
    severity: "error",
    from: { path: "^apps/control-plane/" },
    to: { path: "^modules/" },
  });

  // Backstop. The by-name rules above name the spellings of a deep import that
  // the package exports field refuses, and the spellings are open-ended:
  // round nine added case, percent escapes, backslashes and dot segments, and
  // round ten found percent-encoded scopes and module names, double encoding
  // and Unicode lookalikes still silent in a `.js` source. A `.js` file is not
  // type-checked, so nothing else reports an import that resolves to nothing.
  // This rule does not try to recognise a bypass by its spelling. An import
  // from first-party source that resolves to nothing is an error whatever it
  // says, which also closes the relative import into a `dist/` directory that
  // has not been built (controls C10-3 and C10-4). Node built-ins are not
  // "could not resolve" to the checker, so they are not reported.
  rules.push({
    name: "backstop-no-unresolvable-imports",
    comment:
      "Backstop: an import from modules/, packages/, services/ or apps/ that " +
      "resolves to nothing is an error, however it is spelled. It covers every " +
      "by-name spelling the rules above do not name, and a path into a dist/ " +
      "directory that has not been built.",
    severity: "error",
    from: { path: "^" + ROOTS + "/" },
    to: { couldNotResolve: true },
  });

  return rules;
}

