// VIOLATES rule 1 by package name from a .js file, which the typecheck never
// sees. Only the boundary check stands between this import and main.
import { ALPHA_SECRET } from "@biztrust/alpha/src/internal/secret.js";
export const LEAKED_BY_NAME_JS = ALPHA_SECRET;
