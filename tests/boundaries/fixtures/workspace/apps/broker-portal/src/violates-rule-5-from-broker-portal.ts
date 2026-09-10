// VIOLATES rule 5 from apps/, not services/. Round three loosened rule 5's
// `from: { path: "^(services|apps)/" }` to `^services/` and the suite stayed
// green: the only apps/ fixture is apps/control-plane, and everything it
// imports is rule 6's and rule 7's business, so the apps/ arm of rule 5 was
// enforced by the generator but witnessed by nothing. This app is not the
// control plane, and this import lands on a module's public file that is not
// the contract, same shape as services/api/src/violates-rule-5-public-not-contract.ts.
import { ALPHA_EXTRA } from "../../../modules/alpha/src/public/extra.js";
export const NOT_THE_CONTRACT_FROM_AN_APP = ALPHA_EXTRA;
