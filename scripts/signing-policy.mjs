/**
 * The reader for badf/signing-policy.yaml.
 *
 * A SECOND reader, in a second language, over the same file that
 * `parse_signing_policy` in scripts/validate_continuity.py reads. That is
 * deliberate and it is the same reasoning scripts/agents-registry.mjs
 * records: two readers that must independently agree on a file are harder to
 * fool with one clever line than one reader either language trusts. The
 * Python side owns the DIAGNOSIS - which key is unknown, which seat may not
 * enrol - because it is the record validator; this side owns only what
 * scripts/check-signing.mjs must know to ask git a question, and refuses
 * everything else rather than guessing.
 *
 * Deliberately dependency-free and deliberately strict, in the pattern of
 * scripts/registry.mjs and scripts/agents-registry.mjs: the default is an
 * error. A line that is not blank, not a comment and not one of the shapes
 * below is refused WITH ITS NUMBER, because an earlier reader in this
 * repository skipped what it did not recognise and a peer review defeated it
 * five ways with ordinary, legal YAML.
 *
 * If badf/signing-policy.yaml ever needs a shape this reader refuses, the
 * reader changes in the same pull request, under a Work Package that says why.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./registry.mjs";

export const POLICY_PATH = join(ROOT, "badf", "signing-policy.yaml");

/** The scalar keys, each carrying its value on its own line. */
const SCALARS = new Set(["version", "updated_at", "enforcement_point"]);

/** The fields an accepted-key entry may carry, beyond the identity that opens it. */
const KEY_FIELDS = new Set(["kind", "enrolled_by", "note"]);

const BLOCK_OPENERS = new Set(["", ">", ">-", "|", "|-"]);

/**
 * The literal that says no human identity is bound to this repository.
 *
 * Exported because scripts/check-signing.mjs decides whether to announce
 * NOT_ENFORCED from the ABSENCE of enrolled keys rather than from this word -
 * a policy that said NONE_ENROLLED while listing a key would otherwise get to
 * choose which of the two a reader believes - but the word still has to be
 * spelled the same way in both places.
 */
export const NO_KEYS_ENROLLED = "NONE_ENROLLED";

/** The enforcement point when it is not an explicit sha. */
export const ENFORCEMENT_POINT_LITERAL = "FIRST_COMMIT_OF_THIS_POLICY";

/**
 * A plain relative path.
 *
 * This is a security boundary, not a tidiness rule: every path here is handed
 * to `git log` as a pathspec, and a value beginning with a dash is read by git
 * as an OPTION. A policy that could name `--all` as a protected path would be
 * a policy that could rewrite the question this check asks.
 */
const PLAIN_PATH = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** The enforcement point: the declared literal, or an explicit 40-character sha. */
const SAFE_REVISION = /^(FIRST_COMMIT_OF_THIS_POLICY|[0-9a-f]{40})$/;

export class SigningPolicyError extends Error {}

function unclassified(lineNo, raw) {
  return new SigningPolicyError(
    `line ${lineNo}: matches no rule of this policy's grammar: ${raw.trim()}. ` +
      `This reader refuses what it cannot classify rather than skipping it, ` +
      `because a skipped line is a line a human reading the file still sees`,
  );
}

/**
 * Refuses any value this reader hands to git that is not the exact shape it
 * must be.
 *
 * This is the one SEMANTIC refusal here, and it is a security boundary rather
 * than a tidiness rule: every protected path becomes a `git log` pathspec and
 * the enforcement point becomes a revision, and git reads a leading dash as an
 * OPTION. A policy able to name `--all` as a protected path would be a policy
 * able to rewrite the question this check asks.
 *
 * Everything else about the policy's MEANING - the version, whether
 * accepted_keys is coherent, whether the pinned paths are all present, whether
 * a key was enrolled by a seat an agent may occupy - is refused by
 * parse_signing_policy/validate_signing_policy in
 * scripts/validate_continuity.py, and is deliberately not duplicated here.
 *
 * BE PRECISE ABOUT WHAT THAT MAKES SAFE, because an earlier version of this
 * comment was not, and review caught it. This reader does NOT fail closed on
 * its own. Given
 *
 *     accepted_keys:
 *       - identity: "agent-bot@biztrust.local"
 *         kind: gpg
 *         enrolled_by: platform-engineer     # may_be_an_agent: true
 *
 * the Python validator reports one error and this reader hands
 * scripts/check-signing.mjs a perfectly usable accepted identity. Same for a
 * file that says `accepted_keys: NONE_ENROLLED` and then lists a key. Both are
 * self-enrolment, and neither is refused here.
 *
 * What is true is that this reader is safe IN COMPOSITION, and the composition
 * is an ORDERING: `pnpm verify` runs `validate:records` before `check:signing`,
 * and CI runs the same two steps in the same order. Every ambiguity this
 * reader faces alone resolves toward MORE enforcement, never less - an
 * accepted_keys block it cannot make sense of yields keys, so the check
 * enforces; a protected_paths list it cannot make sense of yields no pathspec,
 * so `git log` returns every commit - so it cannot make the check quieter than
 * it should be. It can, alone, make the check trust an identity nobody
 * legitimate enrolled. Reordering those two steps, or dropping the first, is
 * what this comment exists to warn a future reader against.
 */
function requireGitSafe(kind, value, lineNo, pattern) {
  if (!pattern.test(value) || value.split("/").includes("..")) {
    throw new SigningPolicyError(
      `line ${lineNo}: ${kind} "${value}" is not the shape it must be. This value ` +
        `is handed to git, which reads a leading dash as an OPTION, so a wildcard, ` +
        `a .. segment or a dash is a value that resolves to something other than ` +
        `what it reads as`,
    );
  }
  return value;
}

/**
 * Parses the policy. Returns
 * `{ version, enforcementPoint, protectedPaths, acceptedKeys }`, where
 * `acceptedKeys` is `[{ identity, kind?, enrolled_by?, note? }, ...]` and is
 * empty exactly when no human identity is enrolled.
 *
 * Throws SigningPolicyError, with a line number, on any deviation.
 */
export function parseSigningPolicy(text) {
  const lines = String(text).split(/\r?\n/);
  const scalars = new Map();
  const protectedPaths = [];
  const acceptedKeys = [];
  let section = null; // "protected_paths" | "accepted_keys" | null
  let entry = null;
  let acceptedKeysInline = null;
  let blockIndent = null;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

    const indent = raw.length - raw.trimStart().length;

    if (blockIndent !== null) {
      if (indent >= blockIndent) continue;
      blockIndent = null;
    }

    // A tab is not an indent this reader disagrees with. A tab-indented block
    // made a whole section invisible to an earlier reader in this repository,
    // so a line carrying one matches nothing below and lands on the refusal.
    const tabless = !raw.includes("\t");

    if (tabless && indent === 0) {
      const top = /^(\S+):[ ]*(.*)$/.exec(raw);
      if (top !== null) {
        const key = top[1];
        const value = top[2].trim().replace(/^"(.*)"$/, "$1");
        section = null;
        entry = null;
        if (SCALARS.has(key)) {
          scalars.set(
            key,
            key === "enforcement_point"
              ? requireGitSafe("enforcement_point", value, lineNo, SAFE_REVISION)
              : value,
          );
          continue;
        }
        if (key === "protected_paths") {
          section = "protected_paths";
          continue;
        }
        if (key === "accepted_keys") {
          section = "accepted_keys";
          acceptedKeysInline = value;
          continue;
        }
        // An unknown top-level key is not a shape this grammar has. It claims
        // nothing and falls through to the one refusal at the bottom of the
        // loop, rather than carrying a second `throw` that would have to be
        // mutation-tested separately to prove the same sentence.
      }
    }

    if (tabless && indent === 2 && section === "protected_paths") {
      const item = /^ {2}- (\S+)[ ]*$/.exec(raw);
      if (item !== null) {
        const path = item[1].replace(/^"(.*)"$/, "$1");
        protectedPaths.push(requireGitSafe("protected path", path, lineNo, PLAIN_PATH));
        continue;
      }
    }

    if (tabless && indent === 2 && section === "accepted_keys") {
      const opener = /^ {2}- identity:[ ]*(\S.*)$/.exec(raw);
      if (opener !== null) {
        entry = { identity: opener[1].trim().replace(/^"(.*)"$/, "$1") };
        acceptedKeys.push(entry);
        continue;
      }
    }

    if (tabless && indent === 4 && section === "accepted_keys" && entry !== null) {
      const field = /^ {4}(\S+):[ ]*(.*)$/.exec(raw);
      if (field !== null && KEY_FIELDS.has(field[1])) {
        let value = field[2].trim();
        if (BLOCK_OPENERS.has(value)) {
          blockIndent = 6;
          value = "";
        }
        entry[field[1]] = value.replace(/^"(.*)"$/, "$1");
        continue;
      }
    }

    // Nothing above claimed this line, so it is refused with its number. This
    // is the default, and it is the whole doctrine: the reader this one is
    // written after SKIPPED what it did not recognise, and a peer review
    // defeated it five ways with ordinary, legal YAML.
    throw unclassified(lineNo, raw);
  }

  // `acceptedKeysInline` is read for nothing but the record: whether a key is
  // enrolled is decided by whether any entry was parsed, never by the word the
  // file uses, so a policy that said NONE_ENROLLED while listing a key could
  // not talk this reader out of enforcing. The Python validator refuses that
  // contradiction outright.
  void acceptedKeysInline;

  return {
    version: scalars.get("version") ?? "",
    enforcementPoint: scalars.get("enforcement_point") ?? "",
    protectedPaths,
    acceptedKeys,
  };
}

export function loadSigningPolicy(path = POLICY_PATH) {
  return parseSigningPolicy(readFileSync(path, "utf8"));
}
