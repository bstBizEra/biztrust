/**
 * The CI workflow's own hardening, witnessed.
 *
 * Round ten, security S-9. `.github/workflows/ci.yml` is a governed path and
 * the thing every required check runs through, yet nothing read it: a later
 * edit could put the job token back into the checkout's git config, drop the
 * `scope` job's timeout, or move an action back to a movable tag, and every
 * check would stay green. This reads the file as text (no YAML dependency is
 * installed, and adding one is not an agent's decision) and asserts the four
 * properties that round established.
 *
 * It is a text check of a fixed shape, not a YAML parser: it finds a job by its
 * two-space-indented key under `jobs:` and a step by its `- name:` line. That is
 * all this file's layout needs, and a layout change that defeats it fails the
 * "finds both jobs" control rather than passing silently.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

/** The text of each job under `jobs:`, keyed by job id. */
function jobs(text) {
  const after = text.slice(text.indexOf("\njobs:\n") + "\njobs:\n".length);
  const parts = after.split(/^  ([a-z][a-z0-9_-]*):\s*$/m);
  const byId = {};
  for (let index = 1; index < parts.length; index += 2) byId[parts[index]] = parts[index + 1];
  return byId;
}

/** The text of the step whose `- name:` is `name`, up to the next step. */
function step(job, name) {
  const start = job.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `no step named ${name}`);
  const rest = job.slice(start + 1);
  const next = rest.search(/^ {6}- name: /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const byId = jobs(workflow);

test("ci workflow: the jobs are found, so the controls below read something", () => {
  assert.deepEqual(Object.keys(byId).sort(), ["scope", "verify"]);
});

test("ci workflow: the checkout step does not leave the job token in the git config", () => {
  const checkout = step(byId.verify, "Checkout");
  assert.match(checkout, /^ {10}persist-credentials: false$/m);
});

test("ci workflow: the checkout step still fetches the whole history the signing check needs", () => {
  const checkout = step(byId.verify, "Checkout");
  assert.match(checkout, /^ {10}fetch-depth: 0$/m);
});

test("ci workflow: every job has a timeout", () => {
  for (const [id, text] of Object.entries(byId)) {
    assert.match(text, /^ {4}timeout-minutes: [1-9][0-9]*$/m, `the ${id} job has no timeout-minutes`);
  }
});

test("ci workflow: every action is pinned by a full commit SHA", () => {
  const uses = [...workflow.matchAll(/^\s*uses: (\S+)/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 4, `expected the four actions, found ${uses.join(", ")}`);
  for (const reference of uses) {
    assert.match(reference, /@[0-9a-f]{40}$/, `${reference} is not pinned by a full commit SHA`);
  }
});

// ---- round ten, security S-8: an override is an exact version ---------------------
//
// An override with a range (`^3.1.8`) floats to a later release the next time the
// lockfile is regenerated, which is a dependency decision nobody made. The
// lockfile already pinned 3.1.8; the override is what would have moved it.

test("workspace overrides: every override pins an exact version, not a range", () => {
  const text = readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = text.split(/^overrides:\s*$/m)[1];
  assert.ok(block !== undefined, "pnpm-workspace.yaml has no overrides block, so there is nothing to pin");
  const entries = [...block.matchAll(/^ {2}([^\s:#][^:]*):\s*(.+?)\s*$/gm)];
  assert.ok(entries.length >= 1, "the overrides block names no override");
  for (const [, name, value] of entries) {
    assert.match(value, /^"?[0-9]+\.[0-9]+\.[0-9]+"?$/, `the override of ${name} is ${value}, not an exact version`);
  }
});

// ---- round sixteen, security S15-1: no hook runs around a script CI runs -------
//
// pnpm runs `pre<name>` before and `post<name>` after `pnpm <name>`, so the
// command a CI step runs is more than the script string the boundary pins read.
// Two hook lines in package.json, one moving a violating file out of `tests/`
// and one moving it back, left `pnpm boundaries:check` at exit 0 over a live
// rule-1 violation with every test green, and touched no path CODEOWNERS
// routes. The script names are read from this workflow's `run: pnpm <name>`
// lines rather than written out here, so a step added later is covered too.

/** The script name of every `run: pnpm <name>` line in the workflow, in order. */
const ciScripts = [...workflow.matchAll(/^\s*(?:- )?run:\s+pnpm\s+(?:run\s+)?([^\s#]+)/gm)].map((match) => match[1]);

const scripts = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).scripts ?? {};

/** The `<prefix><name>` hooks package.json defines for a script CI runs. */
function hooks(prefix) {
  assert.ok(ciScripts.length >= 1, "no `run: pnpm <script>` line was read from ci.yml, so no hook is checked");
  return ciScripts.map((name) => `${prefix}${name}`).filter((hook) => Object.hasOwn(scripts, hook));
}

test("ci workflow: the pnpm scripts it runs are read, so the hook controls below read something", () => {
  assert.ok(ciScripts.includes("boundaries:check"), `boundaries:check is not among ${ciScripts.join(", ")}`);
});

test("ci workflow: package.json defines no pre hook for a script CI runs", () => {
  const found = hooks("pre");
  assert.deepEqual(found, [], `pnpm runs these before a script CI runs, and no check reads them: ${found.join(", ")}`);
});

test("ci workflow: package.json defines no post hook for a script CI runs", () => {
  const found = hooks("post");
  assert.deepEqual(found, [], `pnpm runs these after a script CI runs, and no check reads them: ${found.join(", ")}`);
});
