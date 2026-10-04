// VIOLATES rule 1 by package name, spelled with a `..` segment: the specifier
// is not normalised before the checker matches it, so a rule that looks only
// for the literal prefix @biztrust/<module>/src/internal/ never sees it. It
// lives in packages/ on purpose: from a module, rule 2 by name also catches it
// and would hide a rule 1 that no longer matches (round seven, controls N1).
import { ALPHA_SECRET } from "@biztrust/alpha/src/public/../internal/secret.js";
export const LEAKED_BY_NAME_DOTDOT = ALPHA_SECRET;
