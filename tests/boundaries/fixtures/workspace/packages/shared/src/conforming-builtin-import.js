// CONFORMS to every rule: a Node built-in is not an import that "could not be resolved", so the backstop must not report it. Round eleven.
import { readFileSync } from "node:fs";
export const READ = readFileSync;
