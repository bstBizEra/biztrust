// VIOLATES rule 5, second half, with an apps/ TARGET rather than a services/
// one. Round three loosened rule 5b's `to: { path: "^(services|apps)/" }` to
// `^services/` and the suite stayed green: both existing rule-5b fixtures
// (this module and packages/shared) import services/api, so neither one
// exercises the apps/ half of the target regex. This import lands on
// apps/control-plane, an entry point, from inside a module.
import { CONTROL_PLANE } from "../../../../apps/control-plane/src/index.js";
export const UPWARD_INTO_AN_APP = CONTROL_PLANE;
