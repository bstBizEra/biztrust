// CONFORMS to every rule: a package that imports a path which only LOOKS like
// an internal directory. `internalization` and `alphabet` are not `internal`
// and not `alpha`, and a by-name rule that matched them would be reporting the
// wrong thing (round nine, controls R9-m1).
import * as a from "@biztrust/alpha/src/public/internalization";
import * as b from "@biztrust/alphabet/src/internal/secret";
export const LOOKALIKES = [a, b];
