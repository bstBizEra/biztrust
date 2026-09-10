/**
 * The CODEOWNERS generator, witnessed.
 *
 * Round four finding I9, second half: `scripts/generate-codeowners.mjs` is 389
 * lines, runs in `pnpm verify` and in CI, and had no test at all. Everything
 * it decides was unwitnessed: whether a role-named owner becomes a team slug,
 * whether a routing entry with no owner is refused, whether `--check` actually
 * fails on a stale file, and whether it ever emits a PERSON rather than a
 * team - which is the one thing this repository exists to refuse.
 *
 * `renderCodeowners` is exercised DIRECTLY against hand-built registries
 * rather than only through the real file: the real registry has one shape of
 * each case at most, so a mutation that broke the prose branch, or the
 * duplicate-team branch, would still produce a byte-identical
 * .github/CODEOWNERS and pass `--check`. The two spawned tests cover what an
 * in-process call cannot: the exit codes and the staleness comparison.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderCodeowners } from "../../scripts/generate-codeowners.mjs";
import { loadAgentsRegistry, RegistryError } from "../../scripts/agents-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SCRIPT = join(ROOT, "scripts", "generate-codeowners.mjs");
const CODEOWNERS = join(ROOT, ".github", "CODEOWNERS");

function run(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? -1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

/** A registry shaped like badf/agents.yaml's, built by hand so each branch of
 * the renderer has an input of its own. */
function registry(routing) {
  return {
    version: "0.0.0-fixture",
    roles: [{ id: "platform-engineer" }, { id: "peer-reviewer" }],
    routing,
  };
}

test("--check passes on this repository and reports the routing entries it read", () => {
  const { code, out } = run(["--check"]);
  assert.equal(code, 0, `.github/CODEOWNERS must be current; got:\n${out}`);
  const { routing } = loadAgentsRegistry();
  assert.match(
    out,
    new RegExp(`CODEOWNERS_GENERATION PASS ${routing.length} routing entries`),
    `expected the generator to report the number of routing entries it read ` +
      `(${routing.length}); got:\n${out}`,
  );
});

test("--check refuses a stale file and refuses a missing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "biztrust-codeowners-"));
  try {
    const stale = join(dir, "CODEOWNERS");
    writeFileSync(stale, `${readFileSync(CODEOWNERS, "utf8")}apps/** @someone\n`, "utf8");
    const staleRun = run(["--check"], { CODEOWNERS_TEST_OUT: stale });
    assert.equal(
      staleRun.code,
      1,
      `a hand edit of the generated file must FAIL --check, not merely be ` +
        `reported; got ${staleRun.code}:\n${staleRun.out}`,
    );
    assert.match(staleRun.out, /is stale/, staleRun.out);

    const missingRun = run(["--check"], { CODEOWNERS_TEST_OUT: join(dir, "absent") });
    assert.equal(missingRun.code, 1, missingRun.out);
    assert.match(missingRun.out, /is missing/, missingRun.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real .github/CODEOWNERS is exactly what the generator renders", () => {
  assert.equal(renderCodeowners(loadAgentsRegistry()), readFileSync(CODEOWNERS, "utf8"));
});

test("a routing entry naming a declared role emits that role's TEAM slug", () => {
  const out = renderCodeowners(
    registry([{ path: '"db/migrations/**"', owner: "platform-engineer", verifier: "peer-reviewer" }]),
  );
  assert.ok(
    out.includes("db/migrations/** @bstBizEra/platform-engineer @bstBizEra/peer-reviewer"),
    `expected one CODEOWNERS line naming both seats as team slugs; got:\n${out}`,
  );
});

test("the generator never emits a person, only a team slug under the org", () => {
  // The one thing this file must never do. Every non-comment line must name
  // owners of the form @<org>/<role>, never a bare @handle: a team can exist
  // with zero members, which is exactly what every seat in badf/agents.yaml
  // is today, while a handle would assert that a named human holds one.
  const out = renderCodeowners(loadAgentsRegistry());
  for (const line of out.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    for (const owner of line.split(/\s+/).slice(1)) {
      assert.match(
        owner,
        /^@bstBizEra\/[a-z-]+$/,
        `every owner must be a team slug under the organisation, never a person ` +
          `or a bare handle; found ${owner} on: ${line}`,
      );
    }
  }
});

test("a routing entry whose owner is prose emits a note and no ownership line", () => {
  const out = renderCodeowners(
    registry([
      {
        path: '"modules/**"',
        owner: "the owner_role of the module in modules/modules.yaml",
        verifier: "peer-reviewer",
      },
    ]),
  );
  assert.ok(
    out.includes(
      '# modules/**: owner is "the owner_role of the module in modules/modules.yaml", not a fixed seat',
    ),
    `prose that names no fixed seat must be emitted as a note, not silently ` +
      `dropped and not turned into a team; got:\n${out}`,
  );
  assert.ok(
    out.includes("modules/** @bstBizEra/peer-reviewer"),
    `the verifier still names a declared role and must still be emitted; got:\n${out}`,
  );
});

test("a routing entry with no fixed seat at all emits no ownership line", () => {
  const out = renderCodeowners(
    registry([{ path: '"docs/**"', owner: "somebody sensible", verifier: "somebody else" }]),
  );
  assert.ok(
    out.includes("# docs/**: no fixed seat, so no CODEOWNERS line is emitted"),
    `got:\n${out}`,
  );
  assert.ok(!/^docs\//m.test(out), `no ownership line may be emitted; got:\n${out}`);
});

test("a routing entry recording no owner or no verifier is refused", () => {
  for (const missing of ["owner", "verifier"]) {
    const entry = { path: '"db/migrations/**"', owner: "platform-engineer", verifier: "peer-reviewer" };
    delete entry[missing];
    assert.throws(
      () => renderCodeowners(registry([entry])),
      (error) =>
        error instanceof RegistryError &&
        error.message.includes(`records no ${missing}`),
      `a routing entry with no ${missing} must be REFUSED, not rendered as an ` +
        `unowned path - an unowned governance path is how a review requirement ` +
        `disappears without anyone recording that`,
    );
  }
});
