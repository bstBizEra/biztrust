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
 * Declared non-coverage: `enhancedResolveOptions.exportsFields` and
 * `conditionNames`. Without them a deep by-name import resolves through a
 * workspace link and the path rules report it instead of the by-name rules, so
 * no plant tells the two apart; the by-name rules are witnessed in
 * boundary-rules.test.mjs. `reporterOptions` only changes how a report reads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const GENERATOR = join(ROOT, "scripts", "generate-boundary-rules.mjs");
const DEPCRUISE = join(ROOT, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");
const FIXTURE_HELPER = "tests/boundaries/fixtures/workspace/tests/helpers/src/index.ts";

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

    for (const plant of Object.values(PLANTS)) {
      for (const [file, text] of [[plant.file, plant.text], ...(plant.needs ?? [])]) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), text, "utf8");
      }
    }

    let stdout;
    try {
      stdout = execFileSync(
        process.execPath,
        [DEPCRUISE, "--config", ".dependency-cruiser.cjs", "--output-type", "json", "modules", "packages", "services", "apps", "tests"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      // Non-zero is EXPECTED: every plant is a violation.
      stdout = error.stdout ?? "";
      assert.notEqual(stdout.trim(), "", `the checker produced no report: ${error.stderr ?? error}`);
    }
    return { generated, violations: JSON.parse(stdout).summary.violations };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const { generated, violations } = cruiseWithTheGeneratedOptions();
const norm = (path) => String(path).replace(/\\/g, "/");
const rulesFor = (file) => violations.filter((v) => norm(v.from) === file).map((v) => v.rule.name);

function assertReported(plant, rule) {
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
