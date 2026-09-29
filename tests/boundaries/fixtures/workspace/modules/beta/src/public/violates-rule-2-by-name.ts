// VIOLATES rule 2 by package name: imports another module by a deep path
// instead of the bare @biztrust/<module> contract.
import { ALPHA_PUBLIC } from "@biztrust/alpha/src/public/index.js";
export const DEEP = ALPHA_PUBLIC;
