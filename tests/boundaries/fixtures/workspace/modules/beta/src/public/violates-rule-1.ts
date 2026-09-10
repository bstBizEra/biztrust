// VIOLATES rule 1: reaches into another module's internals.
import { ALPHA_SECRET } from "../../../alpha/src/internal/secret.js";
export const LEAKED = ALPHA_SECRET;
