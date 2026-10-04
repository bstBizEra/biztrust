// VIOLATES rule 1 by package name, spelled with a percent-encoded query after
// the directory (%3F is a question mark). Round nine, controls R9-m1.
import * as internals from "@biztrust/alpha/src/internal%3Fx";
export const LEAKED_BY_NAME_PERCENT_QUERY = internals;
