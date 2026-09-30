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
