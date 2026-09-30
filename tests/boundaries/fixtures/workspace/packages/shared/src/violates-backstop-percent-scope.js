// VIOLATES the backstop: a percent-encoded scope (%40 is @) that names a module's internals. No by-name rule spells it, Node refuses it, and a .js file is never type-checked, so only the backstop reports it. Round eleven, controls C10-3.
import * as internals from "%40biztrust/alpha/src/internal/secret";
export const LEAKED_BY_PERCENT_SCOPE = internals;
