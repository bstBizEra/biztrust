// VIOLATES rule 5, second half, from a PACKAGE. Peer review F4: the only
// fixture was a module, so narrowing `from` to ^modules/ went undetected.
import { API } from "../../../services/api/src/index.js";
export const ENTRY_POINT_IN_A_PACKAGE = API;
