// VIOLATES rule 1 by package name, spelled with a percent-encoded slash after the directory (%2F). Round nine,
// controls R9-m1.
import * as internals from "@biztrust/alpha/src/internal%2Fsecret";
export const LEAKED_BY_NAME_PERCENT_SLASH = internals;
