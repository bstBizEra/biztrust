// VIOLATES the backstop: a relative import into a module's dist/ when nothing has been built, so it resolves to nothing. CI never builds. Round eleven, controls C10-4.
import "../../../modules/alpha/dist/internal/secret.js";
