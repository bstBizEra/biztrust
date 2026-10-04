/**
 * What `pnpm install` reads, read the way the install-lifecycle pins in
 * tests/boundaries/ci-workflow.test.mjs need it.
 *
 * Round eighteen, K1 and K2. The pins read the workspace globs and matched one
 * spelling of a key per line regex, and pnpm 11.9.0 read more than either: the
 * manifests of a glob written with a trailing comment, a `package.yaml` or
 * `package.json5`, and a `pnpmfile` key written quoted or as an explicit `?`
 * key. Both readers here fail closed: git that cannot list the tracked files
 * throws, and a top-level YAML line that is not a key this reader understands
 * throws, rather than being skipped.
 */

import { execFileSync } from "node:child_process";

/** The file names pnpm reads as a project manifest. */
export const MANIFEST_NAMES = ["package.json", "package.yaml", "package.json5"];

/** The ways `topLevelKeys` reports a key was written. */
export const SPELLINGS = ["plain", "double-quoted", "single-quoted", "explicit"];

/**
 * Every git-tracked file under `root` named as a project manifest, as a path
 * relative to `root` with forward slashes. Throws when git cannot answer.
 */
export function trackedManifests(root) {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return listed.split("\0").filter((path) => MANIFEST_NAMES.includes(path.slice(path.lastIndexOf("/") + 1)));
}

const PLAIN = /^([A-Za-z0-9_$./][^:#]*?)\s*:(?:\s|$)/;
const DOUBLE = /^"((?:[^"\\]|\\.)*)"\s*:(?:\s|$)/;
const SINGLE = /^'((?:[^']|'')*)'\s*:(?:\s|$)/;
const EXPLICIT = /^\?\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([A-Za-z0-9_$./][^#]*?))\s*(?:#.*)?$/;

/**
 * The keys of a YAML document's top-level block mapping, each with how it was
 * written and its 1-based line: `[{ key, spelling, line }]`.
 *
 * Every root key of a block mapping starts in column 0, so every other line in
 * column 0 is a comment, a `- ` item or `: ` value of the key above it, or a
 * line this reader cannot read, which throws (a flow mapping, an anchor or tag
 * on a key, a merge key, a document marker, a directive). A double-quoted key's
 * escapes are decoded as JSON's, and one JSON does not know throws. A
 * single-quoted key's doubled quote is left as written: no key a pin refuses
 * contains a quote. Lines break where YAML breaks them, a lone CR included.
 */
export function topLevelKeys(text) {
  const keys = [];
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (line === "" || /^[\s#]/.test(line) || /^[-:](?:\s|$)/.test(line)) return;
    const unreadable = () => new Error(`line ${index + 1} is not a top-level key this reader can read: ${line}`);
    let match;
    let entry;
    if ((match = PLAIN.exec(line))) entry = { key: match[1], spelling: "plain" };
    else if ((match = DOUBLE.exec(line))) entry = { key: decodeDouble(match[1], unreadable), spelling: "double-quoted" };
    else if ((match = SINGLE.exec(line))) entry = { key: match[1], spelling: "single-quoted" };
    else if ((match = EXPLICIT.exec(line))) {
      const key = match[1] !== undefined ? decodeDouble(match[1], unreadable) : (match[2] ?? match[3]);
      entry = { key, spelling: "explicit" };
    } else throw unreadable();
    keys.push({ ...entry, line: index + 1 });
  });
  return keys;
}

function decodeDouble(body, unreadable) {
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    throw unreadable();
  }
}
