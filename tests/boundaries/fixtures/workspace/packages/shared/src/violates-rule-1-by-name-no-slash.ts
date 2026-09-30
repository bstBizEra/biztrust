// VIOLATES rule 1 by package name, naming the internal DIRECTORY with no
// trailing slash. A rule anchored on `src/internal/` does not match it
// (round seven, controls N1). In packages/ so that no other rule reports it.
import * as internals from "@biztrust/alpha/src/internal";
export const LEAKED_BY_NAME_NO_SLASH = internals;
