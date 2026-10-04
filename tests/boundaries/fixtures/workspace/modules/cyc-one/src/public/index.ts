// VIOLATES rule 3 with cyc-two: the two contracts import each other.
import { CYC_TWO } from "../../../cyc-two/src/public/index.js";
export const CYC_ONE = "one";
export const SEEN = CYC_TWO;
