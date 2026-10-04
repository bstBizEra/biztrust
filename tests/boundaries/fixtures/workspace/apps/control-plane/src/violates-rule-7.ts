// VIOLATES rule 7: the control plane calling a module contract in-process,
// which would pass the P0.3 chain, the P0.4 resolver and the audit by.
import { ALPHA_CONTRACT } from "../../../modules/alpha/src/public/index.js";
export const IN_PROCESS = ALPHA_CONTRACT;
