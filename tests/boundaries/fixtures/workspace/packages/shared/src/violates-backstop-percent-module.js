// VIOLATES the backstop: a percent-encoded letter in the module name (%61 is a). Round eleven, controls C10-3.
import * as internals from "@biztrust/%61lpha/src/internal/secret";
export const LEAKED_BY_PERCENT_MODULE = internals;
