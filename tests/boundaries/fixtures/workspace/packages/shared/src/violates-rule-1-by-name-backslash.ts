// VIOLATES rule 1 by package name, spelled with backslashes for separators.
// The specifier below holds real backslash characters once TypeScript reads
// the escapes, which is what the checker matches. Round nine, controls R9-m1.
import * as internals from "@biztrust/alpha/src\\internal\\secret";
export const LEAKED_BY_NAME_BACKSLASH = internals;
