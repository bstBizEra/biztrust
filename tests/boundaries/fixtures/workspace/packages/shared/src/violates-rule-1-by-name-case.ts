// VIOLATES rule 1 by package name, spelled with other upper and lower case letters. The specifier is matched as
// written, so a case-sensitive rule never sees it (round nine, controls R9-m1).
// In packages/ on purpose: no other rule reports it there.
import * as internals from "@BizTrust/Alpha/src/Internal/secret";
export const LEAKED_BY_NAME_CASE = internals;
