// CONFORMS to rule 5: an app sees contracts and packages only. This app's
// own apps/control-plane counterpart never imports a module contract (it
// only imports packages/shared), so before this file the CONFORMING list
// had no apps/*-to-module-contract proof: a rule-5 `to` clause that dropped
// its `pathNot: "...index\\.ts$"` exclusion for the apps arm would report
// every legitimate app-to-contract import and nothing here would notice.
import { ALPHA_CONTRACT } from "../../../modules/alpha/src/public/index.js";
export const BROKER_PORTAL = ALPHA_CONTRACT;
