/**
 * The module registry reader.
 *
 * `modules/modules.yaml` is the ONE list of modules; the boundary rule, the
 * TypeScript path map and the migration lint are all generated from it. This
 * reader is deliberately dependency-free and deliberately strict: it accepts
 * only the shape the registry actually has, and throws on anything else, in
 * the pattern of the continuity validator of the guide repository. A silent
 * accept of a malformed registry would generate a rule set that protects
 * nothing, which is the failure mode worth spending strictness on.
 *
 * It is NOT a general YAML parser. If the registry ever needs a shape this
 * reader refuses, the reader changes in the same pull request, under a Work
 * Package that says why.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTRY_PATH = join(ROOT, "modules", "modules.yaml");

const GROUPS = new Set(["platform", "brokerage", "financial", "integration"]);

const FIELDS = [
  "name",
  "group",
  "owner_role",
  "contract",
  "schema",
  "epic",
  "source",
  "package",
];

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SCHEMA = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

class RegistryError extends Error {}

function scalar(raw, line) {
  const text = raw.trim();
  if (text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  if (text === "") {
    throw new RegistryError(`line ${line}: empty value; use null explicitly`);
  }
  return text;
}

/**
 * Parses the registry. Returns { version, modules }.
 * Throws RegistryError with a line number on any deviation.
 */
export function parseRegistry(text) {
  const lines = text.split(/\r?\n/);
  const modules = [];
  let version = null;
  let inModules = false;
  let current = null;

  const closeCurrent = (lineNo) => {
    if (current === null) return;
    for (const field of FIELDS) {
      if (!(field in current.value)) {
        throw new RegistryError(
          `line ${lineNo}: module "${current.value.name ?? "?"}" is missing the ` +
            `required field "${field}"`,
        );
      }
    }
    modules.push(current.value);
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    if (!inModules) {
      const top = /^([a-z_]+):\s*(.*)$/.exec(line);
      if (top) {
        const [, key, rest] = top;
        if (key === "modules") {
          if (rest.trim() !== "") {
            throw new RegistryError(`line ${lineNo}: modules must be a block list`);
          }
          inModules = true;
          continue;
        }
        if (key === "version") {
          version = scalar(rest, lineNo);
          continue;
        }
        // An unknown top-level key used to be silently skipped, so a field
        // could sit in the registry looking authoritative while nothing read
        // it (peer review F12 found `generated_from` doing exactly that).
        throw new RegistryError(
          `line ${lineNo}: unknown top-level key "${key}"; this reader accepts ` +
            `only "version" and "modules", and silently ignoring a key would ` +
            `let it look authoritative while nothing reads it`,
        );
      }
      throw new RegistryError(`line ${lineNo}: unrecognised top-level line`);
    }

    const entry = /^ {2}- ([a-z_]+):\s*(.*)$/.exec(line);
    if (entry) {
      closeCurrent(lineNo);
      const [, key, rest] = entry;
      if (key !== "name") {
        throw new RegistryError(
          `line ${lineNo}: a module entry must start with "name", found "${key}"`,
        );
      }
      current = { value: { name: scalar(rest, lineNo) } };
      continue;
    }

    const field = /^ {4}([a-z_]+):\s*(.*)$/.exec(line);
    if (field) {
      if (current === null) {
        throw new RegistryError(`line ${lineNo}: field outside a module entry`);
      }
      const [, key, rest] = field;
      if (!FIELDS.includes(key)) {
        throw new RegistryError(`line ${lineNo}: unknown field "${key}"`);
      }
      if (key in current.value) {
        throw new RegistryError(`line ${lineNo}: duplicate field "${key}"`);
      }
      current.value[key] = scalar(rest, lineNo);
      continue;
    }

    throw new RegistryError(`line ${lineNo}: unrecognised line: ${line}`);
  }
  closeCurrent(lines.length);

  if (version === null) throw new RegistryError("registry has no version");
  if (modules.length === 0) throw new RegistryError("registry lists no modules");
  return { version, modules };
}

/** Field-level and cross-row rules the shape alone cannot express. */
export function validateRegistry(registry) {
  const errors = [];
  const names = new Set();
  const schemas = new Map();

  for (const m of registry.modules) {
    const where = `module "${m.name}"`;
    if (typeof m.name !== "string" || !NAME.test(m.name)) {
      errors.push(`${where}: name must be lower-kebab-case`);
    }
    if (names.has(m.name)) errors.push(`${where}: duplicate name`);
    names.add(m.name);

    if (!GROUPS.has(m.group)) {
      errors.push(`${where}: group "${m.group}" is not one of ${[...GROUPS].join(", ")}`);
    }
    if (typeof m.owner_role !== "string" || m.owner_role === "") {
      errors.push(`${where}: owner_role is required`);
    }
    if (m.contract !== "src/public/index.ts") {
      errors.push(
        `${where}: contract must be src/public/index.ts, found "${m.contract}"`,
      );
    }
    if (m.schema !== "none") {
      if (typeof m.schema !== "string" || !SCHEMA.test(m.schema)) {
        errors.push(`${where}: schema must be lower_snake_case or "none"`);
      }
      const expected = String(m.name).replace(/-/g, "_");
      if (m.schema !== expected) {
        errors.push(
          `${where}: schema "${m.schema}" is not derived from the name; expected "${expected}"`,
        );
      }
      if (schemas.has(m.schema)) {
        errors.push(`${where}: schema "${m.schema}" is already owned by "${schemas.get(m.schema)}"`);
      }
      schemas.set(m.schema, m.name);
    }
    if (typeof m.package !== "boolean") {
      errors.push(`${where}: package must be true or false`);
    }
    if (m.source !== "contract" && !String(m.source).startsWith("design:")) {
      errors.push(
        `${where}: source must be "contract" or "design:<epic>", found "${m.source}"`,
      );
    }
    if (m.package === true && m.epic === null) {
      errors.push(`${where}: a package directory exists but no epic fills it`);
    }
  }
  return errors;
}

export function loadRegistry(path = REGISTRY_PATH) {
  const registry = parseRegistry(readFileSync(path, "utf8"));
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    const err = new RegistryError(
      `modules/modules.yaml is invalid:\n  ${errors.join("\n  ")}`,
    );
    throw err;
  }
  return registry;
}

export { RegistryError };
