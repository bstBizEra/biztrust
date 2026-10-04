// VIOLATES rule 1 by package name, spelled with a dot segment between the scope and the package name. Round
// nine, controls R9-m1.
import * as internals from "@biztrust/./alpha/src/internal/secret";
export const LEAKED_BY_NAME_SCOPE_DOT = internals;
