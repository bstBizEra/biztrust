// VIOLATES rule 4 from a DIFFERENT package. Peer review F4: with one package
// in the fixture, narrowing rule 4's `from` to ^packages/shared/ passed.
import { ALPHA_CONTRACT } from "../../../modules/alpha/src/public/index.js";
export const DOMAIN_IN_THE_SECOND_PACKAGE = ALPHA_CONTRACT;
