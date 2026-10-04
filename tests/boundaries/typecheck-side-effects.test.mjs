/**
 * `pnpm typecheck` is a second layer over the boundary check, and for one
 * shape of import it was no layer at all.
 *
 * Round nine, controls R9-m2. TypeScript does not resolve a side-effect-only
 * import (`import "x";`) unless `noUncheckedSideEffectImports` is set, so an
 * import of an unresolvable path passed `tsc` in silence: the boundary check
 * reports it only when it can name a rule, and the compiler was assumed to
 * report the rest. It did not. These tests run the compiler with the options
 * the repository actually uses (tsconfig.base.json, extended by absolute
 * path) over a temporary project.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const BASE = join(ROOT, "tsconfig.base.json").replace(/\\/g, "/");

/** Compiles a temporary project holding `files` with the repository's base options. */
function compile(files) {
  const dir = mkdtempSync(join(tmpdir(), "biztrust-typecheck-"));
  try {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ extends: BASE, compilerOptions: { noEmit: true }, include: ["*.ts"] }),
      "utf8",
    );
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, "utf8");
    const run = spawnSync(process.execPath, [TSC, "-p", dir], { encoding: "utf8" });
    return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("typecheck: a side-effect import of a path that resolves to nothing fails the compiler", () => {
  const result = compile({ "plant.ts": 'import "./does-not-exist.js";\nexport {};\n' });
  assert.notEqual(result.status, 0, `the compiler accepted an unresolvable side-effect import:\n${result.output}`);
  assert.match(result.output, /TS2307|TS2882/, result.output);
});

test("typecheck: a side-effect import of a file that exists still compiles", () => {
  const result = compile({
    "plant.ts": 'import "./there.js";\nexport {};\n',
    "there.ts": "export {};\n",
  });
  assert.equal(result.status, 0, `a resolvable side-effect import must compile:\n${result.output}`);
});
