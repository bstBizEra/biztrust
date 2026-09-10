/**
 * The role and routing registry reader for badf/agents.yaml.
 *
 * Deliberately dependency-free and deliberately strict, in the pattern of
 * scripts/registry.mjs and the authority/skills/agents readers in
 * scripts/validate_continuity.py: it accepts only the shape badf/agents.yaml
 * actually has, and REFUSES anything else, rather than silently skipping a
 * line it does not recognise. A silent skip is how a peer review forged a
 * grant three registries used to check for nothing but a `version:` line;
 * the default here is an error, not a `continue`.
 *
 * It is NOT a general YAML parser, and it is independent of the Python
 * reader in scripts/validate_continuity.py by design - two readers in two
 * languages that must independently agree on the same file are harder to
 * fool with one clever line than one reader either language trusts.
 *
 * If badf/agents.yaml ever needs a shape this reader refuses, the reader
 * changes in the same pull request, under a Work Package that says why.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./registry.mjs";

export const AGENTS_PATH = join(ROOT, "badf", "agents.yaml");

const ROLE_FIELDS = ["owns", "may_be_an_agent", "note", "held_by"];
const ROUTING_FIELDS = ["owner", "verifier", "note"];
const BLOCK_OPENERS = new Set(["", ">", ">-", "|", "|-"]);

class RegistryError extends Error {}

/**
 * Parses badf/agents.yaml. Returns { version, roles, routing }.
 *
 *   roles   [{ id, owns?, may_be_an_agent?, note?, held_by? }, ...]
 *   routing [{ path, owner?, verifier?, note? }, ...]
 *
 * Throws RegistryError with a line number on any deviation.
 */
export function parseAgentsRegistry(text) {
  const lines = text.split(/\r?\n/);
  let version = null;
  const roles = [];
  const routing = [];
  let section = null; // "roles" | "routing" | null
  let currentRole = null;
  let currentRoute = null;
  let blockIndent = null;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

    const indent = raw.length - raw.trimStart().length;

    // A folded or literal scalar's body is anything indented past the field
    // that opened it, exactly as parse_authority documents in the Python
    // reader. It is prose, and it is not read for meaning.
    if (blockIndent !== null) {
      if (indent >= blockIndent) continue;
      blockIndent = null;
    }

    if (raw.includes("\t")) {
      throw new RegistryError(
        `line ${lineNo}: contains a tab; this file is space-indented`,
      );
    }

    if (indent === 0) {
      const top = /^(\S+):\s*(.*)$/.exec(raw);
      if (!top) {
        throw new RegistryError(
          `line ${lineNo}: neither a top-level key nor indented under one: ${raw.trim()}`,
        );
      }
      const [, key, restRaw] = top;
      const rest = restRaw.trim();
      currentRole = null;
      currentRoute = null;
      if (key === "roles") {
        if (rest !== "") {
          throw new RegistryError(`line ${lineNo}: "roles" carries an inline value`);
        }
        section = "roles";
        continue;
      }
      if (key === "routing") {
        if (rest !== "") {
          throw new RegistryError(`line ${lineNo}: "routing" carries an inline value`);
        }
        section = "routing";
        continue;
      }
      if (key === "version") {
        version = rest;
        section = null;
        continue;
      }
      if (key === "updated_at") {
        section = null;
        continue;
      }
      // An unknown top-level key used to be silently skipped elsewhere in
      // this repository, which let a field sit in a registry looking
      // authoritative while nothing read it.
      throw new RegistryError(`line ${lineNo}: unknown top-level key "${key}"`);
    }

    if (section === null) {
      throw new RegistryError(
        `line ${lineNo}: indented content outside roles: or routing:: ${raw.trim()}`,
      );
    }

    if (indent === 2) {
      if (section === "roles") {
        const m = /^ {2}- id:\s*(\S.*)$/.exec(raw);
        if (!m) {
          throw new RegistryError(
            `line ${lineNo}: a role entry must open with "- id: <value>": ${raw.trim()}`,
          );
        }
        currentRole = { id: m[1].trim() };
        roles.push(currentRole);
        continue;
      }
      const m = /^ {2}- path:\s*(\S.*)$/.exec(raw);
      if (!m) {
        throw new RegistryError(
          `line ${lineNo}: a routing entry must open with "- path: <value>": ${raw.trim()}`,
        );
      }
      currentRoute = { path: m[1].trim() };
      routing.push(currentRoute);
      continue;
    }

    if (indent === 4) {
      const m = /^ {4}(\S+):\s*(.*)$/.exec(raw);
      if (!m) {
        throw new RegistryError(`line ${lineNo}: not a field of an entry: ${raw.trim()}`);
      }
      const [, field, valueRaw] = m;
      let value = valueRaw.trim();

      if (section === "roles") {
        if (!currentRole) {
          throw new RegistryError(`line ${lineNo}: a field outside any role entry`);
        }
        if (!ROLE_FIELDS.includes(field)) {
          throw new RegistryError(`line ${lineNo}: unknown field "${field}" on a role entry`);
        }
        if (BLOCK_OPENERS.has(value)) {
          blockIndent = 6;
          value = "";
        }
        currentRole[field] = value;
        continue;
      }

      if (!currentRoute) {
        throw new RegistryError(`line ${lineNo}: a field outside any routing entry`);
      }
      if (!ROUTING_FIELDS.includes(field)) {
        throw new RegistryError(`line ${lineNo}: unknown field "${field}" on a routing entry`);
      }
      if (BLOCK_OPENERS.has(value)) {
        blockIndent = 6;
        value = "";
      }
      currentRoute[field] = value;
      continue;
    }

    throw new RegistryError(
      `line ${lineNo}: indented ${indent} spaces, which is neither a section, ` +
        `an entry nor a field: ${raw.trim()}`,
    );
  }

  if (version === null) throw new RegistryError("registry has no version");
  if (roles.length === 0) throw new RegistryError("registry lists no roles");
  if (routing.length === 0) throw new RegistryError("registry lists no routing entries");

  return { version, roles, routing };
}

export function loadAgentsRegistry(path = AGENTS_PATH) {
  return parseAgentsRegistry(readFileSync(path, "utf8"));
}

export { RegistryError };
