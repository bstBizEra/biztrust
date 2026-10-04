// VIOLATES rule 6 from a MODULE. Peer review F4: narrowing rule 6's `from` to
// services/ alone left a module free to import the P0.7 bypass package.
import { HELPER } from "../../../../tests/helpers/src/index.js";
export const TEST_CODE_IN_A_MODULE = HELPER;
