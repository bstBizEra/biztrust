// VIOLATES rule 5 by package name, spelled with other case: an entry point
// reaches past a contract through @BizTrust/Alpha/src/..., which a case-sensitive
// rule never sees (round nine, controls R9-m1).
import { ALPHA_SECRET } from "@BizTrust/Alpha/src/internal/secret.js";
export const BYPASS_CASE = ALPHA_SECRET;
