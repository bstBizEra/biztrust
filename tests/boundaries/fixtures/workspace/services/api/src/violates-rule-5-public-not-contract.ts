// VIOLATES rule 5, sharper form. Peer review F4: the only rule-5 fixture
// imported an INTERNAL path, so widening the rule to allow any src/public/
// file went undetected. This lands on a public file that is not the contract.
import { ALPHA_EXTRA } from "../../../modules/alpha/src/public/extra.js";
export const NOT_THE_CONTRACT = ALPHA_EXTRA;
