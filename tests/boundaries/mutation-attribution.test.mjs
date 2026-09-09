/**
 * The controls for the mutation sweep's own attribution.
 *
 * `scripts/mutation-check.mjs` used to record a mutation as `caught` when the
 * suite went red for any reason at all. That is the same shape of defect the
 * sweep exists to find one level down - a green suite that proves nothing
 * about the rule it names - and four review rounds found that shape four
 * times. `scripts/mutation-attribution.mjs` is the half of the fix that can
 * be tested directly: it is pure, so every refusal it makes is witnessed here
 * by an assertion on the MESSAGE, and the sweep mutates this file the same
 * way it mutates the boundary rules and the migration lint.
 *
 * Witnessing them by spawning the sweep instead would not work: a sweep runs
 * this suite, so a test that spawns a sweep from inside one is unbounded
 * recursion rather than a control (see mutation-check-guard.test.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readTap,
  readUnittest,
  witnessesOf,
  witnessedBy,
  rosterDefect,
  anchorDefect,
  declarationDefects,
  indistinguishable,
  overlaps,
  verdict,
} from "../../scripts/mutation-attribution.mjs";

const TAP = [
  "TAP version 13",
  "# Subtest: control 1: a rule is enforced",
  "ok 1 - control 1: a rule is enforced",
  "  ---",
  "  duration_ms: 0.7",
  "  ...",
  "not ok 2 - control 2: another rule is enforced",
  "  ---",
  "  failureType: 'testCodeFailure'",
  "  ...",
  "ok 3 - control 3: a rule nobody ran # SKIP already inside a sweep",
  "1..3",
].join("\n");

test("TAP: only a control reported not ok is read as a killer", () => {
  assert.deepEqual(readTap(TAP).failed, ["control 2: another rule is enforced"]);
});

test("TAP: every control the suite ran is read into the roster, skipped ones included", () => {
  assert.deepEqual(readTap(TAP).names, [
    "control 1: a rule is enforced",
    "control 2: another rule is enforced",
    "control 3: a rule nobody ran",
  ]);
});

test("TAP: an indented subtest result is not read as a second control", () => {
  const nested = ["ok 1 - parent", "    not ok 1 - child", "not ok 2 - parent two"].join("\n");
  assert.deepEqual(readTap(nested).names, ["parent", "parent two"]);
});

const UNITTEST = [
  "test_one (tests.unit.t.Case.test_one) ... ok",
  "test_two (tests.unit.t.Case.test_two) ... FAIL",
  "test_three (tests.unit.t.Case.test_three) ... ERROR",
  "",
  "======================================================================",
  "FAIL: test_two (tests.unit.t.Case.test_two)",
  "----------------------------------------------------------------------",
  "AssertionError: nope",
  "======================================================================",
  "ERROR: test_three (tests.unit.t.Case.test_three)",
  "----------------------------------------------------------------------",
  "KeyError: 'missing'",
].join("\n");

test("unittest: a control that FAILED and a control that ERRORED are both killers", () => {
  assert.deepEqual(readUnittest(UNITTEST).failed, ["test_two", "test_three"]);
});

test("unittest: the verbose per-test line is what puts a control in the roster", () => {
  assert.deepEqual(readUnittest(UNITTEST).names, ["test_one", "test_two", "test_three"]);
});

test("an anchor that appears twice is refused rather than rewriting the first copy", () => {
  const source = ['      pathNot: "^modules/",', '  pathNot: "^modules/",'].join("\n");
  assert.equal(
    anchorDefect(source, '  pathNot: "^modules/",', "rule 5: a loosening"),
    "rule 5: a loosening: the anchor this mutation rewrites appears more than once, " +
      "so it rewrites the first copy - which need not be the rule the name claims",
  );
});

test("an anchor that appears once is accepted", () => {
  assert.equal(anchorDefect('  pathNot: "^modules/",', '  pathNot: "^modules/",', "m"), null);
});

test("an anchor that is gone is refused as a mutation that stopped testing", () => {
  assert.equal(
    anchorDefect("nothing like it here", "the anchor", "m"),
    "m: the anchor this mutation rewrites is not in the file any more, so the " +
      "mutation stopped testing anything",
  );
});

const ROSTER = new Map([
  ["boundaries", new Set(["control 1", "control 2"])],
  ["validator", new Set(["test_one"])],
]);

test("a mutation that declares no witness is refused", () => {
  const { undeclared } = declarationDefects(
    [{ name: "m", suite: "boundaries" }],
    ROSTER,
  );
  assert.deepEqual(undeclared, [
    'm: declares no witness, so "the suite went red" is all this mutation proves - ' +
      "which is what a sibling control going red looks like too",
  ]);
});

test("a witness that names no test in its own suite is refused", () => {
  const { unknownWitness } = declarationDefects(
    [{ name: "m", suite: "validator", witness: "control 1" }],
    ROSTER,
  );
  assert.deepEqual(unknownWitness, [
    "m: declares a witness that names no test in the validator suite: control 1",
  ]);
});

test("borrowing a witness another mutation already claims is refused without a reason", () => {
  const entries = [
    { name: "m one", suite: "boundaries", witness: "control 1" },
    { name: "m two", suite: "boundaries", witness: "control 1" },
    { name: "m three", suite: "boundaries", witness: "control 1", shared: "one guard, two halves" },
  ];
  const { undeclaredSharing } = declarationDefects(entries, ROSTER);
  assert.deepEqual(undeclaredSharing, [
    "m two: declares a witness m one already claims, and records no reason for " +
      "borrowing it: control 1",
  ]);
});

test("a declared witness that no other mutation declares is accepted", () => {
  const entries = [
    { name: "m one", suite: "boundaries", witness: "control 1" },
    { name: "m two", suite: "boundaries", witness: ["control 2"] },
    { name: "m three", suite: "validator", witness: "test_one" },
  ];
  assert.deepEqual(declarationDefects(entries, ROSTER), {
    undeclared: [],
    unknownWitness: [],
    undeclaredSharing: [],
  });
});

test("two mutations killed by exactly the same controls are refused unless one records a reason", () => {
  const killedBy = new Map([
    ["m one", ["control 1", "control 2"]],
    ["m two", ["control 1", "control 2"]],
    ["m three", ["control 1"]],
  ]);
  const reasons = new Map([["m two", "one guard, two halves"]]);
  assert.deepEqual(indistinguishable(killedBy, reasons), [
    "m one: is killed by exactly the controls that kill m two, so no control in " +
      "this suite tells them apart, and it records no reason for sharing",
  ]);
});

test("a mutation with a killer set no other mutation shares is accepted", () => {
  const killedBy = new Map([
    ["m one", ["control 1"]],
    ["m two", ["control 1", "control 2"]],
  ]);
  assert.deepEqual(indistinguishable(killedBy, new Map()), []);
});

test("only the declared witnesses that actually went red are credited", () => {
  const mutation = { witness: ["control 1", "control 2"] };
  assert.deepEqual(witnessedBy(mutation, ["control 2", "control 9"]), ["control 2"]);
  assert.deepEqual(witnessedBy(mutation, ["control 9"]), []);
  assert.deepEqual(witnessesOf({ witness: ["control 1", "  ", 7] }), ["control 1"]);
});

test("the overlap report names both directions of the relation", () => {
  const killedBy = new Map([
    ["m one", ["control 1", "control 2"]],
    ["m two", ["control 1"]],
  ]);
  const { multiplyKilled, multiplyKilling } = overlaps(killedBy);
  assert.deepEqual(multiplyKilled, [["m one", ["control 1", "control 2"]]]);
  assert.deepEqual(multiplyKilling, [["control 1", ["m one", "m two"]]]);
});

test("the overlap report names the mutations no control kills alone", () => {
  // "m two" dies only under a control that also kills "m one", so nothing in
  // the suite covers it by itself; "m one" has `control 2` to itself.
  const killedBy = new Map([
    ["m one", ["control 1", "control 2"]],
    ["m two", ["control 1"]],
  ]);
  assert.deepEqual(overlaps(killedBy).withoutExclusiveKiller, ["m two"]);
});

test("a baseline suite that named no test at all is refused", () => {
  assert.equal(
    rosterDefect("validator", "python -m unittest", []),
    "the validator baseline suite (python -m unittest) reported no test at all, so " +
      "no mutation could be attributed to a control and no declared witness could be " +
      "checked for existence",
  );
});

test("a baseline suite that named one control twice is refused", () => {
  assert.equal(
    rosterDefect("boundaries", "node --test", ["control 1", "control 2", "control 1"]),
    "the boundaries baseline suite (node --test) reported the same control name more " +
      "than once, so two controls collapse into one and a witness could be credited " +
      "to whichever of them went red: control 1",
  );
});

test("a baseline suite whose control names are all distinct is accepted", () => {
  assert.equal(rosterDefect("boundaries", "node --test", ["control 1", "control 2"]), null);
});

/**
 * The verdict's terms, enumerated here INDEPENDENTLY of the alternation in
 * `scripts/mutation-attribution.mjs`.
 *
 * Deriving this list from `VERDICT_TERMS` would be worse than useless:
 * deleting a term from the module would delete its control too, and a control
 * that no longer exists cannot go red. That is the whole failure this pair of
 * lists exists to catch - review of this task deleted `misattributed` from the
 * hand-rolled sum and watched the sweep print every misattribution it found
 * and exit 0.
 */
const EMPTY_BUCKETS = {
  survived: [],
  anchorDefects: [],
  undeclared: [],
  unknownWitness: [],
  undeclaredSharing: [],
  undeclaredTwins: [],
  misattributed: [],
};

for (const term of Object.keys(EMPTY_BUCKETS)) {
  test(`the run fails when ${term} is not empty`, () => {
    const { code, summary } = verdict({ ...EMPTY_BUCKETS, [term]: ["one entry"] });
    assert.equal(code, 1, `a non-empty ${term} bucket must fail the run`);
    assert.match(summary, /^MUTATION_CHECK FAIL /);
  });
}

test("the run passes only when every term is empty", () => {
  assert.deepEqual(verdict({ ...EMPTY_BUCKETS }), { code: 0, summary: null });
});

test("the verdict counts every term it was given, in its summary", () => {
  const { summary } = verdict({ ...EMPTY_BUCKETS, survived: ["a"], misattributed: ["b", "c"] });
  assert.match(summary, /1 survived/);
  assert.match(summary, /2 caught by something other than their witness/);
});

test("a bucket the verdict was not given is a defect, not an empty bucket", () => {
  const { misattributed, ...missing } = EMPTY_BUCKETS;
  assert.throws(() => verdict(missing), {
    message:
      "verdict was not given the misattributed bucket, so that term could not be counted",
  });
});
