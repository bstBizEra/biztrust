/**
 * The PRODUCTION checker options, witnessed.
 *
 * Round nine, controls R9-C1 and R9-C2. The fixture suite in
 * boundary-rules.test.mjs builds its own checker options (no `exclude`, no
 * `tsConfig`, no `exportsFields`), so a change to the options the generator
 * writes into `.dependency-cruiser.cjs` moved nothing it could see. A reviewer
 * widened `exclude` by ONE alternative, `/internal/`, and `pnpm
 * boundaries:check`, all 187 boundary tests and the coverage gate stayed green
 * while every rule went blind to an internals import. The same file also
 * excluded `dist/` and the fixture tree as dependency TARGETS, so a service
 * importing tracked test code, or a built `modules/<m>/dist/internal/`, had no
 * edge for any rule to judge.
 *
 * This file cruises with the options the generator writes, byte for byte, and
 * plants one violation per option that could hide it. It builds a temporary
 * copy of the workspace so the real tree is never edited, and it creates the
 * `dist/` files there because `dist/` is gitignored: a committed fixture under
 * a dist directory cannot exist.
 *
 * Each test names ONE plant and ONE rule, so loosening one option turns
 * exactly the plants that option hides red, and the mutation sweep can say
 * which control caught which loosening.
 *
 * Round eleven (controls C10-1 to C10-4). Round ten's eight plants all had a
 * source in services/api/src, packages/ or one module's public directory, so
 * `doNotFollow` widened by `/internal/`, `^tests/` or `^apps/` moved none of
 * them while blinding every rule to the imports OF those files, and the claim
 * above held for the options it named and not for the one it did not. There is
 * now a plant whose source is in each source root (a module's internal and
 * public directories, packages, apps, tests, services), one for each shape the
 * old unanchored pattern swallowed (a file NAMED node_modules, a directory
 * named node_modules, a nested dist/), and six for the backstop rule that
 * reports an import which resolves to nothing. A plant that is green at the
 * committed options is red under the loosening it guards; the mutations in
 * scripts/mutation-check.mjs tagged C10-1 to C10-4 are those loosenings.
 *
 * Round twelve (control R12-2). Round eleven's plants were one per SOURCE ROOT
 * and not one per IMPORT FORM: none used a dynamic `import()`, a `require()`,
 * an `export ... from`, or a `.mjs` or `.cjs` source. `exclude: { dynamic:
 * true }`, `moduleSystems: ["es6", "tsd"]` and a `|\.mjs$` or `|\.cjs$` added
 * to `doNotFollow` each blinded every rule to one form in every root, and
 * `boundaries:check`, this file and the whole boundary suite stayed green
 * (and the mutation sweep too, since no mutation loosened them). There is now
 * a plant for each form, reaching another module's internals (and, for two of
 * them, test code, which is rule 6), and each is asserted against the rule
 * that names it.
 *
 * The plants find a loosening only if someone thinks of it. The second half of
 * the fix does not depend on that: the options object the generator writes is
 * pinned below, key by key and value by value, to a list written out in this
 * file. A key the list does not name, or a value it does not match, fails
 * until this file is changed on purpose. That is not what `--check` does:
 * `--check` compares the committed file with what the generator renders NOW,
 * so a loosened generator and its regenerated output agree and it passes. The
 * pin is the comparison that does not move when the generator moves.
 *
 * Round fourteen (control R14-1). The pin above covered the `options` object
 * and nothing else the checker runs with. Two more inputs configure it: the
 * argument list of `pnpm boundaries:check` in package.json, and the top-level
 * keys of `.dependency-cruiser.cjs`. This file used to cruise with an argument
 * list of its own, so `--exclude "^services/api/src/legacy/"` added to that
 * script, a scanned root dropped from it, or a top-level `extends` naming a
 * file with a looser `exclude` hid a live rule-1 and rule-5 violation while
 * `boundaries:check`, this file, the whole boundary suite and the mutation
 * sweep all stayed green. The copy is now cruised with the depcruise arguments
 * READ FROM package.json, so a loosened script loosens the cruise here and the
 * plants it hides go red; and those arguments, the generation step before
 * them and the config's top-level keys are pinned below the same way the
 * options are. A script this file cannot read as a plain argument list fails
 * rather than being guessed at.
 *
 * Declared non-coverage: what the pinned `exportsFields` and `conditionNames`
 * DO. Without them a deep by-name import resolves through a workspace link and
 * the path rules report it instead of the by-name rules, so no plant tells the
 * two apart; the by-name rules are witnessed in boundary-rules.test.mjs. The
 * pin covers that they stay as written, not that they behave. `reporterOptions`
 * only changes how a report reads, and is pinned for the same reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const GENERATOR = join(ROOT, "scripts", "generate-boundary-rules.mjs");
const DEPCRUISE = join(ROOT, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");
const FIXTURE_HELPER = "tests/boundaries/fixtures/workspace/tests/helpers/src/index.ts";

// ---- round fourteen (R14-1): the boundaries:check script, read as CI runs it ----

/**
 * Splits a package.json script into its `&&`-joined commands, each a list of
 * arguments, the way the POSIX shell on the CI runner would.
 *
 * Only the plain subset is read: bare words, single-quoted text, and
 * double-quoted text with no `$`, backtick or backslash in it. Anything else a
 * shell would expand, redirect, pipe or glob is refused with a reason rather
 * than guessed at, because a guess that differs from the shell is exactly a
 * cruise here that is not the cruise CI runs.
 */
function readScript(script) {
  if (typeof script !== "string" || script.trim() === "") {
    return { error: `the script is ${JSON.stringify(script)}, not a command` };
  }
  const commands = [[]];
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    if (c === " " || c === "\t") {
      i += 1;
      continue;
    }
    if (script.startsWith("&&", i)) {
      commands.push([]);
      i += 2;
      continue;
    }
    let word = "";
    while (i < script.length && script[i] !== " " && script[i] !== "\t") {
      const d = script[i];
      if (d === "'" || d === '"') {
        const end = script.indexOf(d, i + 1);
        if (end === -1) return { error: `an unclosed ${d} at offset ${i}` };
        const inner = script.slice(i + 1, end);
        if (d === '"' && /[$`\\]/.test(inner)) {
          return { error: `double-quoted text the shell would expand: ${d}${inner}${d}` };
        }
        word += inner;
        i = end + 1;
      } else if (/[A-Za-z0-9_./:@^=+,%-]/.test(d)) {
        word += d;
        i += 1;
      } else {
        return { error: `a character the shell gives a meaning to, ${JSON.stringify(d)}, at offset ${i}` };
      }
    }
    commands[commands.length - 1].push(word);
  }
  if (commands.some((command) => command.length === 0)) {
    return { error: "an empty command on one side of &&" };
  }
  return { commands };
}

/** What CI runs as `pnpm boundaries:check`, read from package.json now. */
const BOUNDARIES_CHECK = (() => {
  const script = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts?.["boundaries:check"];
  const read = readScript(script);
  const depcruise = read.commands?.find((command) => command[0] === "depcruise");
  return {
    script,
    error: read.error ?? (depcruise === undefined ? "no command in it runs depcruise" : null),
    commands: read.commands ?? [],
    // The arguments after `depcruise`, which this file cruises the copy with.
    argv: depcruise === undefined ? null : depcruise.slice(1),
  };
})();

/** Every plant: the file, what it says, and any file it needs to resolve to. */
const PLANTS = {
  fixtureTree: {
    file: "services/api/src/plant-fixture-tree.ts",
    text: 'import "../../../tests/boundaries/fixtures/workspace/tests/helpers/src/index.ts";\n',
  },
  distRelative: {
    file: "services/api/src/plant-dist-relative.ts",
    text: 'import "../../../modules/tenancy/dist/internal/tenant-store.js";\n',
    needs: [["modules/tenancy/dist/internal/tenant-store.js", "export const built = true;\n"]],
  },
  distByName: {
    file: "services/api/src/plant-dist-by-name.ts",
    text: 'import "@biztrust/audit/dist/internal/append-only.js";\n',
  },
  srcInternalFromJs: {
    file: "services/api/src/plant-src-internal.js",
    text: 'import "../../../modules/tenancy/src/internal/tenant-store.ts";\n',
  },
  noExtension: {
    file: "services/api/src/plant-no-extension.ts",
    text: 'import "../../../modules/tenancy/src/internal/tenant-store";\n',
  },
  typeOnly: {
    file: "services/api/src/plant-type-only.ts",
    text: 'import type { TenantRow } from "../../../modules/tenancy/src/internal/tenant-store.ts";\n' +
      "export type Plant = TenantRow;\n",
  },
  bareModuleFromPackage: {
    file: "packages/contracts/src/plant-bare-module.ts",
    text: 'import "@biztrust/tenancy";\n',
  },
  distFromModule: {
    file: "modules/identity-access/src/public/plant-dist-from-module.ts",
    text: 'import "../../../tenancy/dist/public/index.js";\n',
    needs: [["modules/tenancy/dist/public/index.js", "export const built = true;\n"]],
  },

  // ---- round eleven, controls C10-1 and C10-2 -----------------------------
  //
  // One plant per SOURCE ROOT, so a loosening of `doNotFollow` or `exclude`
  // that blinds the checker to the imports OF one root turns that root's plant
  // red. Round ten's eight plants all sat in services/api/src, packages/ and
  // modules/identity-access/src/public/, so `|/internal/` (every module's
  // implementation), `|^tests/` and `|^apps/` added to doNotFollow moved none
  // of them, and the claim above that the file plants "one violation per
  // option that could hide it" did not hold for doNotFollow.
  internalSource: {
    file: "modules/tenancy/src/internal/plant-internal-source.ts",
    text: 'import "../../../audit/src/internal/append-only.ts";\nexport const reach = 1;\n',
  },
  publicSource: {
    file: "modules/identity-access/src/public/plant-public-source.ts",
    text: 'import "../../../tenancy/src/internal/tenant-store.ts";\n',
  },
  packagesSource: {
    file: "packages/contracts/src/plant-packages-source.ts",
    text: 'import "../../../modules/tenancy/src/internal/tenant-store.ts";\n',
  },
  appsSource: {
    file: "apps/control-plane/src/plant-apps-source.ts",
    text: 'import "../../../modules/tenancy/src/internal/tenant-store.ts";\n',
  },
  testsSource: {
    file: "tests/bypass/src/plant-tests-source.ts",
    text: 'import "../../../modules/tenancy/src/internal/tenant-store.ts";\n',
  },
  // The edge INTO an entry point, which `exclude` removes and `doNotFollow` keeps.
  importsAnApp: {
    file: "packages/contracts/src/plant-imports-an-app.ts",
    text: 'import "../../../apps/control-plane/src/plant-apps-source.ts";\n',
  },

  importsAService: {
    file: "packages/contracts/src/plant-imports-a-service.ts",
    text: 'import "../../../services/api/src/index.ts";\n',
  },

  // C10-1. The reviewer's reproduction: a re-export in a file whose NAME
  // contains node_modules, reached from another file, and with the old
  // unanchored pattern never followed, so the rule-6 edge to tests/ was never
  // judged and every check stayed green. The consumer and the stand-in for the
  // P0.7 bypass package are files the plant needs, not plants.
  nodeModulesNamedFile: {
    file: "services/api/src/node_modules-bridge.ts",
    text: 'export { runAsApplicationRole } from "../../../tests/bypass/src/index.js";\n',
    needs: [
      ["tests/bypass/src/index.ts", "export const runAsApplicationRole = () => 1;\n"],
      [
        "services/api/src/plant-via-the-bridge.ts",
        'import { runAsApplicationRole } from "./node_modules-bridge.js";\n' +
          "export const reached = runAsApplicationRole;\n",
      ],
    ],
  },
  // A first-party DIRECTORY named node_modules below a package root: not a
  // dependency, so still source.
  nodeModulesNamedDirectory: {
    file: "services/api/src/node_modules/plant-shim.ts",
    text: 'import "../../../../modules/tenancy/src/internal/tenant-store.ts";\n',
  },
  // A directory named dist at depth: only build output sits at
  // <root>/<package>/dist, so this one is source.
  nestedDist: {
    file: "services/api/src/dist/plant-nested-dist.ts",
    text: 'import "../../../../modules/tenancy/src/internal/tenant-store.ts";\n',
  },

  // C10-3 and C10-4. A `.js` source is not type-checked, so an import that
  // resolves to nothing was reported by no rule and no compiler. Each of these
  // resolves to nothing; the catch-all rule reports them all, however spelled.
  percentScope: {
    file: "packages/contracts/src/plant-percent-scope.js",
    text: 'import "%40biztrust/audit/src/internal/append-only";\n',
  },
  doublePercent: {
    file: "packages/contracts/src/plant-double-percent.js",
    text: 'import "@biztrust/audit/src/%2569nternal/append-only";\n',
  },
  lookalike: {
    file: "packages/contracts/src/plant-lookalike.js",
    // U+0456, Cyrillic small byelorussian-ukrainian i, for the Latin i of "internal".
    text: 'import "@biztrust/audit/src/іnternal/append-only";\n',
  },
  unresolvableInAModule: {
    file: "modules/tenancy/src/public/plant-unresolvable-in-a-module.js",
    text: 'import "@biztrust/audit/src/%2569nternal/append-only";\n',
  },
  unresolvableInAnApp: {
    file: "apps/control-plane/src/plant-unresolvable-in-an-app.js",
    text: 'import "@biztrust/audit/src/%2569nternal/append-only";\n',
  },
  distWithNoBuild: {
    file: "services/api/src/plant-dist-with-no-build.js",
    text: 'import "../../../modules/audit/dist/internal/append-only.js";\n',
  },

  // ---- round twelve, control R12-2: one plant per IMPORT FORM --------------
  //
  // Every plant above is a static `import` in a `.ts` or `.js` file. These are
  // the other forms a source file can reach across a boundary with, each in
  // services/api/src and each with a literal specifier, so the only thing that
  // can hide it is an option that blinds the checker to that form.
  dynamicImport: {
    file: "services/api/src/plant-dynamic-import.ts",
    text: 'export const load = () => import("../../../modules/tenancy/src/internal/tenant-store.ts");\n',
  },
  dynamicImportOfTests: {
    file: "services/api/src/plant-dynamic-import-of-tests.ts",
    text: 'export const load = () => import("../../../tests/bypass/src/index.ts");\n',
    needs: [["tests/bypass/src/index.ts", "export const runAsApplicationRole = () => 1;\n"]],
  },
  requireInCjs: {
    file: "services/api/src/plant-require-in-cjs.cjs",
    text: 'const store = require("../../../modules/tenancy/src/internal/tenant-store.ts");\n' +
      "module.exports = { store };\n",
  },
  // A `.js` file, so a loosening of moduleSystems is told apart from one of
  // doNotFollow for `.cjs`: the first hides this and the second does not.
  requireInJs: {
    file: "services/api/src/plant-require-in-js.js",
    text: 'const store = require("../../../modules/tenancy/src/internal/tenant-store.ts");\n' +
      "module.exports = { store };\n",
  },
  mjsReexport: {
    file: "services/api/src/plant-reexport.mjs",
    text: 'export * from "../../../modules/tenancy/src/internal/tenant-store.ts";\n',
  },
  mjsReexportOfTests: {
    file: "services/api/src/plant-reexport-of-tests.mjs",
    text: 'export { runAsApplicationRole } from "../../../tests/bypass/src/index.ts";\n',
    needs: [["tests/bypass/src/index.ts", "export const runAsApplicationRole = () => 1;\n"]],
  },
  cjsReexport: {
    file: "services/api/src/plant-reexport.cjs",
    text: 'module.exports = require("../../../modules/tenancy/src/internal/tenant-store.ts");\n',
  },
  exportFrom: {
    file: "services/api/src/plant-export-from.ts",
    text: 'export { TENANCY_SCHEMA } from "../../../modules/tenancy/src/internal/tenant-store.ts";\n',
  },
};

function cruiseWithTheGeneratedOptions() {
  const root = mkdtempSync(join(tmpdir(), "biztrust-production-options-"));
  try {
    for (const name of ["modules", "packages", "services", "apps"]) {
      cpSync(join(ROOT, name), join(root, name), {
        recursive: true,
        filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
      });
    }
    for (const name of ["tsconfig.json", "tsconfig.base.json"]) {
      cpSync(join(ROOT, name), join(root, name));
    }
    mkdirSync(dirname(join(root, FIXTURE_HELPER)), { recursive: true });
    cpSync(join(ROOT, FIXTURE_HELPER), join(root, FIXTURE_HELPER));

    // The options are the GENERATOR's, produced now, so a loosening of the
    // generator is a loosening here. tsconfig.paths.json is written beside it.
    execFileSync(process.execPath, [GENERATOR, "--out-dir", root], { cwd: ROOT, stdio: "ignore" });

    const generated = {};
    for (const name of [".dependency-cruiser.cjs", "tsconfig.paths.json"]) {
      generated[name] = readFileSync(join(root, name), "utf8") === readFileSync(join(ROOT, name), "utf8");
    }

    // The config the generator wrote, read before the copy is removed: the
    // whole module, so its top-level keys can be pinned as well as its
    // options. `require` caches, so the committed file is read separately and
    // below.
    const config = createRequire(import.meta.url)(join(root, ".dependency-cruiser.cjs"));

    for (const plant of Object.values(PLANTS)) {
      for (const [file, text] of [[plant.file, plant.text], ...(plant.needs ?? [])]) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text, "utf8");
      }
    }

    // R14-1: the arguments are package.json's, not a list written here, so a
    // loosened boundaries:check is a loosened cruise. The JSON output type is
    // put FIRST so an output type in the script, which would make the report
    // unreadable here, wins and fails loudly rather than being overridden.
    // A cruise that cannot run or report is recorded, not thrown: thrown here
    // it would fail this file before any test is named, and the mutation sweep
    // could not tell which control caught what.
    if (BOUNDARIES_CHECK.argv === null) {
      return { generated, config, violations: [], cruiseError: `boundaries:check: ${BOUNDARIES_CHECK.error}` };
    }
    let stdout;
    let stderr = "";
    try {
      stdout = execFileSync(
        process.execPath,
        [DEPCRUISE, "--output-type", "json", ...BOUNDARIES_CHECK.argv],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      // Non-zero is EXPECTED: every plant is a violation.
      stdout = error.stdout ?? "";
      stderr = String(error.stderr ?? error);
    }
    try {
      return { generated, config, violations: JSON.parse(stdout).summary.violations, cruiseError: null };
    } catch {
      return { generated, config, violations: [], cruiseError: `the checker produced no readable report: ${stderr}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const { generated, config, violations, cruiseError } = cruiseWithTheGeneratedOptions();
const options = config.options;
// The committed file, read from the repository root: the config CI cruises with.
const committedConfig = createRequire(import.meta.url)(join(ROOT, ".dependency-cruiser.cjs"));
const committedOptions = committedConfig.options;
const norm = (path) => String(path).replace(/\\/g, "/");
const rulesFor = (file) => violations.filter((v) => norm(v.from) === file).map((v) => v.rule.name);

/** Every test that reads the report fails, by name, when there is no report. */
function assertCruised() {
  assert.equal(cruiseError, null, `the copy was not cruised as boundaries:check would cruise it: ${cruiseError}`);
}

function assertReported(plant, rule) {
  assertCruised();
  const fired = rulesFor(plant.file);
  assert.ok(
    fired.includes(rule),
    `expected ${plant.file} to be reported for ${rule} by the options the generator writes; ` +
      `the checker reported ${fired.length === 0 ? "nothing at all" : fired.join(", ")}`,
  );
}

test("production options: the config this file cruises with is the committed one", () => {
  assert.deepEqual(generated, { ".dependency-cruiser.cjs": true, "tsconfig.paths.json": true });
});

test("production options: the copy of the workspace without a plant is reported by no rule", () => {
  assertCruised();
  const planted = new Set(Object.values(PLANTS).map((plant) => plant.file));
  const others = violations.filter((v) => !planted.has(norm(v.from)));
  assert.deepEqual(
    others.map((v) => `${v.rule.name}: ${norm(v.from)} -> ${norm(v.to)}`),
    [],
    "only the planted files may be reported; anything else means the options judge the real tree wrongly",
  );
});

test("production options: a service importing the fixture tree is reported as rule-6-test-packages-stay-in-tests", () => {
  assertReported(PLANTS.fixtureTree, "rule-6-test-packages-stay-in-tests");
});

test("production options: a relative import of modules/tenancy/dist/internal is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.distRelative, "rule-1-internals-private-tenancy");
});

test("production options: a relative import of modules/tenancy/dist/internal is reported as rule-5-entry-points-see-contracts-only", () => {
  assertReported(PLANTS.distRelative, "rule-5-entry-points-see-contracts-only");
});

test("production options: an import of @biztrust/audit/dist/internal by name is reported as rule-1-internals-private-by-name-audit", () => {
  assertReported(PLANTS.distByName, "rule-1-internals-private-by-name-audit");
});

test("production options: a js file importing modules/tenancy/src/internal is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.srcInternalFromJs, "rule-1-internals-private-tenancy");
});

test("production options: an import of src/internal spelled with no extension is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.noExtension, "rule-1-internals-private-tenancy");
});

test("production options: a type-only import of src/internal is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.typeOnly, "rule-1-internals-private-tenancy");
});

test("production options: a package importing a module by its bare name is reported as rule-4-packages-import-no-module", () => {
  assertReported(PLANTS.bareModuleFromPackage, "rule-4-packages-import-no-module");
});

test("production options: a module importing another module's dist is reported as rule-2-contracts-only-identity-access", () => {
  assertReported(PLANTS.distFromModule, "rule-2-contracts-only-identity-access");
});

// ---- round eleven: one test per source root (C10-2) --------------------------

test("production options: a module's internal file importing another module's internals is reported as rule-1-internals-private-audit", () => {
  assertReported(PLANTS.internalSource, "rule-1-internals-private-audit");
});

test("production options: a module's internal file importing another module's internals is reported as rule-2-contracts-only-tenancy", () => {
  assertReported(PLANTS.internalSource, "rule-2-contracts-only-tenancy");
});

test("production options: a module's public file importing another module's internals is reported as rule-2-contracts-only-identity-access", () => {
  assertReported(PLANTS.publicSource, "rule-2-contracts-only-identity-access");
});

test("production options: a package file importing a module's internals is reported as rule-4-packages-import-no-module", () => {
  assertReported(PLANTS.packagesSource, "rule-4-packages-import-no-module");
});

test("production options: an app file importing a module's internals is reported as rule-7-control-plane-sees-packages-only", () => {
  assertReported(PLANTS.appsSource, "rule-7-control-plane-sees-packages-only");
});

test("production options: a file under tests importing a module's internals is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.testsSource, "rule-1-internals-private-tenancy");
});

test("production options: a package importing a service is reported as rule-5-nothing-imports-an-entry-point", () => {
  assertReported(PLANTS.importsAService, "rule-5-nothing-imports-an-entry-point");
});

test("production options: a package importing an app is reported as rule-5-nothing-imports-an-entry-point", () => {
  assertReported(PLANTS.importsAnApp, "rule-5-nothing-imports-an-entry-point");
});

// ---- round eleven: the two anchors of doNotFollow (C10-1) --------------------

test("production options: a file whose name contains node_modules is followed, and its import of tests is reported as rule-6-test-packages-stay-in-tests", () => {
  assertReported(PLANTS.nodeModulesNamedFile, "rule-6-test-packages-stay-in-tests");
});

test("production options: a first-party directory named node_modules is followed, and its import of internals is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.nodeModulesNamedDirectory, "rule-1-internals-private-tenancy");
});

test("production options: a directory named dist below a source directory is followed, and its import of internals is reported as rule-5-entry-points-see-contracts-only", () => {
  assertReported(PLANTS.nestedDist, "rule-5-entry-points-see-contracts-only");
});

// ---- round eleven: the catch-all for an import that resolves to nothing -------

const UNRESOLVABLE = "backstop-no-unresolvable-imports";

test("production options: a js file importing a percent-encoded scope is reported as backstop-no-unresolvable-imports", () => {
  assertReported(PLANTS.percentScope, UNRESOLVABLE);
});

test("production options: a js file importing a double percent-encoded directory is reported as backstop-no-unresolvable-imports", () => {
  assertReported(PLANTS.doublePercent, UNRESOLVABLE);
});

test("production options: a js file importing a directory spelled with a Cyrillic lookalike is reported as backstop-no-unresolvable-imports", () => {
  assertReported(PLANTS.lookalike, UNRESOLVABLE);
});

test("production options: a js file importing a module's dist when nothing is built is reported as backstop-no-unresolvable-imports", () => {
  assertReported(PLANTS.distWithNoBuild, UNRESOLVABLE);
});

test("production options: a js file in a module importing a double percent-encoded directory is reported as backstop-no-unresolvable-imports", () => {
  assertReported(PLANTS.unresolvableInAModule, UNRESOLVABLE);
});

test("production options: a js file in an app importing a double percent-encoded directory is reported as backstop-no-unresolvable-imports", () => {
  assertReported(PLANTS.unresolvableInAnApp, UNRESOLVABLE);
});

// ---- round twelve: one test per IMPORT FORM (R12-2) --------------------------

const INTERNALS = "rule-1-internals-private-tenancy";
const ENTRY_POINTS = "rule-5-entry-points-see-contracts-only";
const TESTS_ONLY = "rule-6-test-packages-stay-in-tests";

test("production options: a dynamic import() of tenancy internals is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.dynamicImport, INTERNALS);
});

test("production options: a dynamic import() of tenancy internals is reported as rule-5-entry-points-see-contracts-only", () => {
  assertReported(PLANTS.dynamicImport, ENTRY_POINTS);
});

test("production options: a dynamic import() of test code is reported as rule-6-test-packages-stay-in-tests", () => {
  assertReported(PLANTS.dynamicImportOfTests, TESTS_ONLY);
});

test("production options: a require() in a cjs file of tenancy internals is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.requireInCjs, INTERNALS);
});

test("production options: a require() in a cjs file of tenancy internals is reported as rule-5-entry-points-see-contracts-only", () => {
  assertReported(PLANTS.requireInCjs, ENTRY_POINTS);
});

test("production options: a require() in a js file of tenancy internals is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.requireInJs, INTERNALS);
});

test("production options: a require() in a js file of tenancy internals is reported as rule-5-entry-points-see-contracts-only", () => {
  assertReported(PLANTS.requireInJs, ENTRY_POINTS);
});

test("production options: an mjs re-export of tenancy internals is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.mjsReexport, INTERNALS);
});

test("production options: an mjs re-export of tenancy internals is reported as rule-5-entry-points-see-contracts-only", () => {
  assertReported(PLANTS.mjsReexport, ENTRY_POINTS);
});

test("production options: an mjs re-export of test code is reported as rule-6-test-packages-stay-in-tests", () => {
  assertReported(PLANTS.mjsReexportOfTests, TESTS_ONLY);
});

test("production options: a cjs re-export of tenancy internals is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.cjsReexport, INTERNALS);
});

test("production options: a cjs re-export of tenancy internals is reported as rule-5-entry-points-see-contracts-only", () => {
  assertReported(PLANTS.cjsReexport, ENTRY_POINTS);
});

test("production options: an export-from of tenancy internals is reported as rule-1-internals-private-tenancy", () => {
  assertReported(PLANTS.exportFrom, INTERNALS);
});

test("production options: an export-from of tenancy internals is reported as rule-5-entry-points-see-contracts-only", () => {
  assertReported(PLANTS.exportFrom, ENTRY_POINTS);
});

// ---- round twelve: the options object, pinned to a list written out here (R12-2) ----
//
// Every value below is written out in full on purpose. Deriving one from
// scripts/boundary-rules.mjs would move the pin whenever the generator moves,
// which is the comparison --check already makes and the one this replaces
// nothing of. Changing an option means changing this list in the same pull
// request, and a reviewer reads the change here.
//
// Both objects are pinned: the options the generator writes into the copy, and
// the options in the committed file CI cruises with. The test at the top of
// this file already requires the two files to be byte-identical; pinning both
// keeps the pin true if that test is ever relaxed.

const ALLOWED_OPTIONS = {
  doNotFollow: {
    path:
      "^node_modules/|^(?:modules|packages|services|apps)/[^/]+/node_modules/|" +
      "^(?:modules|packages|services|apps)/[^/]+/dist/|^tests/boundaries/fixtures/",
  },
  tsPreCompilationDeps: true,
  tsConfig: { fileName: "tsconfig.json" },
  enhancedResolveOptions: {
    exportsFields: ["exports"],
    conditionNames: ["import", "require", "node", "default", "types"],
    extensions: [".ts", ".js", ".mjs", ".cjs"],
  },
  reporterOptions: { text: { highlightFocused: true } },
};

/** Both objects, labelled, so a failure says which file's options moved. */
const pinnedOptions = () => [
  ["the options the generator writes", options],
  ["the committed .dependency-cruiser.cjs", committedOptions],
];

function assertPinned(read, expected) {
  for (const [label, found] of pinnedOptions()) {
    assert.deepEqual(read(found), expected, `${label} differ from the allowlist in this file`);
  }
}

test("production options: the option names are exactly the allowlist", () => {
  assertPinned((found) => Object.keys(found).sort(), Object.keys(ALLOWED_OPTIONS).sort());
});

test("production options: the doNotFollow option is exactly the allowlisted pattern and nothing else", () => {
  assertPinned((found) => found.doNotFollow, ALLOWED_OPTIONS.doNotFollow);
});

test("production options: the tsPreCompilationDeps option is exactly true", () => {
  assertPinned((found) => found.tsPreCompilationDeps, true);
});

test("production options: the tsConfig option is exactly the repository tsconfig and nothing else", () => {
  assertPinned((found) => found.tsConfig, ALLOWED_OPTIONS.tsConfig);
});

test("production options: the enhancedResolveOptions names are exactly the allowlist", () => {
  assertPinned(
    (found) => Object.keys(found.enhancedResolveOptions).sort(),
    Object.keys(ALLOWED_OPTIONS.enhancedResolveOptions).sort(),
  );
});

test("production options: the exportsFields resolve option is exactly the allowlist", () => {
  assertPinned(
    (found) => found.enhancedResolveOptions.exportsFields,
    ALLOWED_OPTIONS.enhancedResolveOptions.exportsFields,
  );
});

test("production options: the conditionNames resolve option is exactly the allowlist", () => {
  assertPinned(
    (found) => found.enhancedResolveOptions.conditionNames,
    ALLOWED_OPTIONS.enhancedResolveOptions.conditionNames,
  );
});

test("production options: the extensions resolve option is exactly the allowlist", () => {
  assertPinned(
    (found) => found.enhancedResolveOptions.extensions,
    ALLOWED_OPTIONS.enhancedResolveOptions.extensions,
  );
});

test("production options: the reporterOptions option is exactly the allowlist", () => {
  assertPinned((found) => found.reporterOptions, ALLOWED_OPTIONS.reporterOptions);
});

// ---- round fourteen: what else the checker runs with, pinned (R14-1) ---------
//
// The options above are one of three inputs to the checker CI runs. The other
// two are the arguments of `pnpm boundaries:check` and the top-level keys of
// the config module. Both are written out here for the reason the options are:
// a value derived from the thing it pins moves when that thing moves.

/** The two commands of boundaries:check: regenerate-and-compare, then cruise. */
const ALLOWED_GENERATION = ["node", "scripts/generate-boundary-rules.mjs", "--check"];
const SCANNED_ROOTS = ["modules", "packages", "services", "apps", "tests"];
const ALLOWED_DEPCRUISE_ARGV = ["--config", ".dependency-cruiser.cjs", ...SCANNED_ROOTS];

/**
 * Whether an argument is `long`, its short spelling, or either with an attached value.
 *
 * Round sixteen (code review CR-1): a short flag also counts inside a
 * single-dash cluster, because the CLI parser reads `-mx <re>` as
 * `--metrics --exclude <re>`. Any run of letters after one dash that contains
 * the short letter is refused, even where a parser would read that letter as
 * the value of an earlier flag: a false refusal only fails closed.
 */
const spells = (argument, long, short) =>
  argument === long ||
  argument.startsWith(`${long}=`) ||
  (short !== undefined && (/^-[A-Za-z]+/.exec(argument)?.[0] ?? "").slice(1).includes(short.slice(1)));

function assertReadable() {
  assert.equal(BOUNDARIES_CHECK.error, null, `boundaries:check cannot be read: ${BOUNDARIES_CHECK.error}`);
}

function assertNoFlag(long, short) {
  assertReadable();
  const found = BOUNDARIES_CHECK.argv.filter((argument) => spells(argument, long, short));
  assert.deepEqual(
    found,
    [],
    `boundaries:check passes depcruise ${long}, which hides from every rule whatever it matches: ` +
      BOUNDARIES_CHECK.script,
  );
}

test("production options: the copy is cruised with the depcruise arguments of boundaries:check, and they produce a report", () => {
  assertCruised();
});

test("production options: boundaries:check is exactly the generation check and then depcruise with the allowlisted arguments", () => {
  assertReadable();
  assert.deepEqual(
    BOUNDARIES_CHECK.commands,
    [ALLOWED_GENERATION, ["depcruise", ...ALLOWED_DEPCRUISE_ARGV]],
    `boundaries:check differs from the allowlist in this file: ${BOUNDARIES_CHECK.script}`,
  );
});

test("production options: boundaries:check passes depcruise no --exclude", () => {
  assertNoFlag("--exclude", "-x");
});

test("production options: boundaries:check passes depcruise no --do-not-follow", () => {
  assertNoFlag("--do-not-follow", "-X");
});

test("production options: boundaries:check passes depcruise no --include-only", () => {
  assertNoFlag("--include-only", "-I");
});

test("production options: boundaries:check passes depcruise no --ignore-known", () => {
  assertNoFlag("--ignore-known");
});

test("production options: boundaries:check scans exactly modules, packages, services, apps and tests", () => {
  assertReadable();
  assert.deepEqual(
    BOUNDARIES_CHECK.argv.slice(-SCANNED_ROOTS.length),
    SCANNED_ROOTS,
    `boundaries:check must end with the five scanned roots, and a root it does not name ` +
      `is a root no rule judges: ${BOUNDARIES_CHECK.script}`,
  );
});

/** Both config modules, labelled, as pinnedOptions does for their options. */
const pinnedConfigs = () => [
  ["the config the generator writes", config],
  ["the committed .dependency-cruiser.cjs", committedConfig],
];

test("production options: the config extends no other config", () => {
  for (const [label, found] of pinnedConfigs()) {
    assert.equal(
      Object.hasOwn(found, "extends"),
      false,
      `${label} extends ${JSON.stringify(found.extends)}, whose options and rules this file ` +
        `pins none of; the checker merges them in`,
    );
  }
});

test("production options: the config's top-level keys are exactly forbidden and options", () => {
  for (const [label, found] of pinnedConfigs()) {
    assert.deepEqual(Object.keys(found).sort(), ["forbidden", "options"], `${label} has top-level keys beyond the allowlist`);
  }
});
