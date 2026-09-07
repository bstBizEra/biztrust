// CONFORMS to rule 1: a module may import its own internals.
import { ALPHA_SECRET } from "../internal/secret.js";
// CONFORMS to rule 2: a cross-module import lands on the other contract.
import { BETA_CONTRACT } from "../../../beta/src/public/index.js";
export const ALPHA_CONTRACT = [ALPHA_SECRET, BETA_CONTRACT].join("/");
