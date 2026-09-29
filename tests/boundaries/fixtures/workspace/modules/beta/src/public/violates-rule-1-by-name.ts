// VIOLATES rule 1 by package name: reaches into another module's internals
// through @biztrust/<module>/src/internal/..., which the exports field refuses
// to resolve. Unresolvable is not the same as reported; the rule must name it.
import { ALPHA_SECRET } from "@biztrust/alpha/src/internal/secret.js";
export const LEAKED_BY_NAME = ALPHA_SECRET;
