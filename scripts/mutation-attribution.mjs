/**
 * Attribution for the mutation sweep: WHICH control caught a mutation, not
 * merely that something did.
 *
 * `scripts/mutation-check.mjs` loosens one rule at a time and requires the
 * suite to go red. Four review rounds each found the same defect one level
 * down - the suite was green while the rule did nothing - and the sweep was
 * built to catch exactly that. But a sweep that reads only the EXIT CODE
 * answers a weaker question than it appears to: it records a mutation as
 * `caught` when the suite goes red for ANY reason, including a sibling
 * control that has nothing to do with the rule under test. A rule whose own
 * fixture proves nothing then still counts towards the coverage number,
 * which is the same defect wearing the instrument's own clothes.
 *
 * Everything here is pure - no filesystem, no child process, no clock - so
 * that the sweep's own refusals can be witnessed by ordinary tests
 * (tests/boundaries/mutation-attribution.test.mjs) rather than by spawning
 * the sweep inside itself, which is unbounded recursion rather than a test.
 * That also makes this file mutable BY the sweep: the mutations that name it
 * loosen these refusals one at a time, and each one has its own control.
 */

/**
 * Reads TAP 13, as `node --test --test-reporter=tap` writes it, into the
 * roster of controls the suite ran and the subset that failed.
 *
 * Every test under tests/boundaries is declared at the top level of its file
 * (there is no `describe` and no `t.test` subtest anywhere), so every result
 * line is unindented and each one names exactly one control. Anchoring the
 * pattern at the start of the line is therefore not a shortcut: it is what
 * keeps a nested subtest, if one is ever added, from being counted twice -
 * once under its own name and once under its parent's, which would attribute
 * a mutation to a control that never asserted anything about it.
 *
 * A description may carry a trailing `# SKIP`/`# TODO` directive, which is
 * not part of the name, and may escape `#` and `\`. A skipped control is
 * reported `ok`, so it never counts as a killer - but it must still be read
 * as an EXISTING test, or a witness naming it would be indistinguishable
 * from a witness naming nothing at all.
 */
export function readTap(output) {
  const names = [];
  const failed = [];
  for (const line of String(output).split(/\r?\n/)) {
    const parsed = /^(not ok|ok) [0-9]+ - (.*)$/.exec(line);
    if (parsed === null) continue;
    const name = parsed[2]
      .replace(/\s+#\s+(?:SKIP|TODO)\b.*$/, "")
      .replace(/\\(.)/g, "$1")
      .trim();
    if (name === "") continue;
    names.push(name);
    if (parsed[1] === "not ok") failed.push(name);
  }
  return { names, failed };
}

/**
 * Reads `python -m unittest -v`, which reports in a different format from TAP
 * entirely: one `test_name (module.Class.test_name) ... ok` line per test as
 * it runs, and a separate `FAIL:`/`ERROR:` header block per failure
 * afterwards. The verbose flag is what makes the first half exist at all -
 * without it a green run names none of the tests it ran, and a witness
 * declared against the validator suite could not be checked for existence.
 *
 * ERROR is read exactly as FAIL is: a control that raised before it could
 * assert did not witness anything, but it did go red, and calling that
 * "passed" would let a mutation that breaks the fixture setup look caught.
 *
 * Every test method name in tests/unit is unique across its classes, so the
 * bare method name identifies a control here as the full description does
 * under TAP.
 */
export function readUnittest(output) {
  const names = [];
  const failed = [];
  for (const line of String(output).split(/\r?\n/)) {
    const ran = /^(test_[A-Za-z0-9_]*) \(/.exec(line);
    if (ran !== null) {
      names.push(ran[1]);
      continue;
    }
    const failure = /^(?:FAIL|ERROR): (test_[A-Za-z0-9_]*) \(/.exec(line);
    if (failure !== null) failed.push(failure[1]);
  }
  return { names, failed };
}

/** The controls a mutation declares as the ones that should catch it. */
export function witnessesOf(mutation) {
  const declared = mutation.witness ?? [];
  const list = Array.isArray(declared) ? declared : [declared];
  return list.filter((name) => typeof name === "string" && name.trim() !== "");
}

/** Whether a mutation records a reason for sharing its witness. */
export function reasonOf(mutation) {
  return typeof mutation.shared === "string" && mutation.shared.trim() !== ""
    ? mutation.shared.trim()
    : null;
}

/**
 * The defect in a mutation's anchor, or null.
 *
 * The AMBIGUOUS half is not hypothetical. `rule 5: allow an entry point to
 * import any public file` anchored on a line that is also a SUFFIX of rule
 * 2's more deeply indented line, `String.prototype.replace` rewrites the
 * FIRST match, and rule 2 is generated above rule 5 - so for four review
 * rounds that mutation loosened rule 2, was duly caught by rule 2's control,
 * and reported that rule 5 was covered. The attribution found it and this
 * refusal keeps it found: an anchor that matches twice is refused outright
 * rather than silently rewriting whichever copy comes first.
 */
export function anchorDefect(source, from, name) {
  const first = String(source).indexOf(from);
  if (first < 0) {
    return (
      `${name}: the anchor this mutation rewrites is not in the file any more, ` +
      `so the mutation stopped testing anything`
    );
  }
  if (String(source).indexOf(from, first + 1) >= 0) {
    return (
      `${name}: the anchor this mutation rewrites appears more than once, so it ` +
      `rewrites the first copy - which need not be the rule the name claims`
    );
  }
  return null;
}

/**
 * The declaration defects in a mutation table, decided statically against the
 * roster of controls each suite actually ran.
 *
 * Every entry must carry `{ name, suite, witness }`; `shared` is optional.
 */
export function declarationDefects(entries, roster) {
  const undeclared = [];
  const unknownWitness = [];
  const undeclaredSharing = [];
  const declaredBy = new Map();

  for (const entry of entries) {
    const witnesses = witnessesOf(entry);
    if (witnesses.length === 0) {
      undeclared.push(
        `${entry.name}: declares no witness, so "the suite went red" is all this ` +
          `mutation proves - which is what a sibling control going red looks like too`,
      );
      continue;
    }
    const known = roster.get(entry.suite) ?? new Set();
    for (const witness of witnesses) {
      if (!known.has(witness)) {
        unknownWitness.push(
          `${entry.name}: declares a witness that names no test in the ` +
            `${entry.suite} suite: ${witness}`,
        );
      }
      const key = `${entry.suite}\u0000${witness}`;
      const sharers = declaredBy.get(key) ?? [];
      sharers.push(entry);
      declaredBy.set(key, sharers);
    }
  }

  // The FIRST mutation to declare a control owns it; every later one is
  // borrowing a fixture written to prove something else, and has to say why.
  // Flagging every sharer instead would spread the ceremony of one legitimate
  // borrow onto the mutation that was there first and has nothing of its own
  // to explain, which is how a refusal stops being read.
  for (const [key, sharers] of declaredBy) {
    if (sharers.length < 2) continue;
    const witness = key.split("\u0000")[1];
    for (const entry of sharers.slice(1)) {
      if (reasonOf(entry) !== null) continue;
      undeclaredSharing.push(
        `${entry.name}: declares a witness ${sharers[0].name} already claims, and ` +
          `records no reason for borrowing it: ${witness}`,
      );
    }
  }

  return { undeclared, unknownWitness, undeclaredSharing };
}

/**
 * The mutations no control can tell apart: identical sets of killers.
 *
 * A mutation that dies under exactly the controls another one dies under has
 * no discriminating witness anywhere in the suite, whichever of them it
 * declares - so the declaration is true and the coverage it implies is not.
 * Sometimes that is correct and unavoidable (two independently deletable
 * halves of one behaviour, where the only distinguishing fixture would have
 * to be invented), and `shared` records that judgement with its reasoning.
 * What is refused is leaving it unsaid.
 *
 * `killedBy` maps a mutation name to the sorted controls that went red under
 * it; `reasons` maps a mutation name to its recorded reason, or null.
 */
export function indistinguishable(killedBy, reasons) {
  const groups = new Map();
  for (const [name, killers] of killedBy) {
    if (killers.length === 0) continue;
    const key = killers.join("\u0000");
    const group = groups.get(key) ?? [];
    group.push(name);
    groups.set(key, group);
  }

  const defects = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const name of group) {
      if ((reasons.get(name) ?? null) !== null) continue;
      defects.push(
        `${name}: is killed by exactly the controls that kill ` +
          `${group.filter((other) => other !== name).join(", ")}, so no control in ` +
          `this suite tells them apart, and it records no reason for sharing`,
      );
    }
  }
  return defects;
}

/** The declared witnesses that actually went red, in declaration order. */
export function witnessedBy(mutation, killers) {
  return witnessesOf(mutation).filter((name) => killers.includes(name));
}

/**
 * The two directions of the overlap relation, for the report.
 *
 * Neither is automatically a defect. Both are places where the count of
 * mutations caught is larger than the number of independent things proved,
 * and a reader cannot see that from a pass line.
 */
export function overlaps(killedBy) {
  const kills = new Map();
  for (const [name, killers] of killedBy) {
    for (const killer of killers) {
      const victims = kills.get(killer) ?? [];
      victims.push(name);
      kills.set(killer, victims);
    }
  }
  return {
    multiplyKilled: [...killedBy].filter(([, killers]) => killers.length > 1),
    multiplyKilling: [...kills].filter(([, victims]) => victims.length > 1),
  };
}
