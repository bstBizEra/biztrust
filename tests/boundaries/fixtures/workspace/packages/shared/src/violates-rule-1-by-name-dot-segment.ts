// VIOLATES rule 1 by package name, spelled with a `.` segment between src and
// internal. A rule anchored on the literal prefix `src/internal/` does not
// match it (round seven, controls N1). In packages/ so that no other rule
// reports it.
import { ALPHA_SECRET } from "@biztrust/alpha/src/./internal/secret.js";
export const LEAKED_BY_NAME_DOT_SEGMENT = ALPHA_SECRET;
