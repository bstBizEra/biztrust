#!/usr/bin/env node
/**
 * Runs a Python script with whichever launcher this machine has.
 *
 * CI is Linux and has `python3`. A Windows developer machine typically has the
 * `py` launcher and no `python3` on PATH; the Microsoft Store alias named
 * `python3` exits non-zero with an install prompt, which would read as a failed
 * validation rather than a missing interpreter.
 *
 * This exists so that `pnpm validate:records` is the SAME command everywhere.
 * A validation command that differs by platform is one a checkpoint cannot
 * record honestly.
 *
 *   node scripts/python.mjs scripts/validate_continuity.py [args...]
 *
 * The exit code of the Python process is passed through unchanged, so the
 * 0 / 1 / 2 / 130 contract of the validator survives.
 */

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("usage: node scripts/python.mjs <script.py> [args...]\n");
  process.exit(2);
}

const candidates =
  process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];

for (const launcher of candidates) {
  const result = spawnSync(launcher, args, { stdio: "inherit" });
  // ENOENT means this launcher is absent; try the next one. Any other outcome
  // is the script's own, and its exit code is passed through.
  if (result.error && result.error.code === "ENOENT") continue;
  if (result.error) {
    process.stderr.write(`PYTHON_LAUNCHER FAIL ${launcher}: ${result.error.message}\n`);
    process.exit(2);
  }
  if (result.signal) {
    process.stderr.write(`PYTHON_LAUNCHER FAIL ${launcher} killed by ${result.signal}\n`);
    process.exit(130);
  }
  process.exit(result.status ?? 2);
}

process.stderr.write(
  `PYTHON_LAUNCHER FAIL no Python interpreter found; tried ${candidates.join(", ")}\n`,
);
process.exit(2);
