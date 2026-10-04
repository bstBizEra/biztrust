// VIOLATES rule 2 by package name, spelled with other case: `@BizTrust/Alpha`
// is the same deep import as `@biztrust/alpha`, and a case-sensitive rule never
// sees it (round nine, controls R9-m1).
import { ALPHA_PUBLIC } from "@BizTrust/Alpha/src/public/index.js";
export const DEEP_CASE = ALPHA_PUBLIC;
