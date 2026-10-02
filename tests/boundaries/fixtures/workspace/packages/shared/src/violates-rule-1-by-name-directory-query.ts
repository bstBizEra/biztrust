// VIOLATES rule 1 by package name, spelled naming the directory with a query and nothing after it. `internal/x?q`
// was already reported; `internal?x` was not. Round nine, controls R9-m1.
import * as internals from "@biztrust/alpha/src/internal?x";
export const LEAKED_BY_NAME_DIRECTORY_QUERY = internals;
