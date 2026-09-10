#!/usr/bin/env node
/**
 * The other half of negative control 7: a package exists under modules/ with no
 * registry entry, or a registry row claims a package that is not there.
 *
 * The generator's --check mode catches a rule set that has drifted from the
 * registry. This catches a DIRECTORY that has drifted from it, which the
 * generator cannot see: a package nothing generated a rule for would build,
 * import and be imported with no boundary around it at all.
 *
 *   node scripts/check-module-packages.mjs
 *
 * Exit codes: 0 pass; 1 a data defect; 2 a defect in this script.
 */

import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadRegistry, RegistryError } from "./registry.mjs";

function main() {
  let registry;
  try {
    registry = loadRegistry();
  } catch (error) {
    if (error instanceof RegistryError) {
      process.stderr.write(`MODULE_PACKAGES FAIL ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const rows = new Map(registry.modules.map((m) => [m.name, m]));
  const errors = [];

  // Directories present under modules/ that no row registers.
  const modulesDir = join(ROOT, "modules");
  const onDisk = readdirSync(modulesDir).filter((entry) =>
    statSync(join(modulesDir, entry)).isDirectory(),
  );

  for (const name of onDisk) {
    const row = rows.get(name);
    if (row === undefined) {
      errors.push(
        `modules/${name}: a package directory exists but no row in ` +
          `modules/modules.yaml registers it, so no rule was generated for it ` +
          `and it has no boundary`,
      );
      continue;
    }
    if (row.package !== true) {
      errors.push(
        `modules/${name}: the registry says package: false but the directory ` +
          `exists; set package: true or remove the directory`,
      );
    }
  }

  // Rows claiming a package that is absent, or a contract file that is absent.
  for (const row of registry.modules) {
    if (row.package !== true) continue;
    const dir = join(ROOT, "modules", row.name);
    if (!existsSync(dir)) {
      errors.push(
        `modules/${row.name}: the registry says package: true but the ` +
          `directory does not exist`,
      );
      continue;
    }
    const contract = join(dir, row.contract);
    if (!existsSync(contract)) {
      errors.push(
        `modules/${row.name}: the contract ${row.contract} does not exist, so ` +
          `nothing can import this module through its public entry`,
      );
    }
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) {
      errors.push(`modules/${row.name}: no package.json, so the exports field cannot encapsulate it`);
    }
  }

  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`MODULE_PACKAGES ${error}\n`);
    process.stderr.write(`MODULE_PACKAGES FAIL ${errors.length} violation(s)\n`);
    return 1;
  }

  const packaged = registry.modules.filter((m) => m.package === true).length;
  process.stdout.write(
    `MODULE_PACKAGES PASS ${registry.modules.length} registered, ` +
      `${packaged} with a package, every directory registered\n`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`MODULE_PACKAGES FAIL check defect: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
