// CONFORMS to rule 5: an entry point sees contracts and packages only.
import { ALPHA_CONTRACT } from "../../../modules/alpha/src/public/index.js";
import { SHARED } from "../../../packages/shared/src/index.js";
export const API = [ALPHA_CONTRACT, SHARED].join("/");
