// VIOLATES rule 5 by package name: an entry point reaches past a contract
// through @biztrust/<module>/src/...
import { ALPHA_SECRET } from "@biztrust/alpha/src/internal/secret.js";
export const BYPASS = ALPHA_SECRET;
