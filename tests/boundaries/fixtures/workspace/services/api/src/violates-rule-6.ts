// VIOLATES rule 6: a test-only package reached from a shipping entry point.
import { HELPER } from "../../../tests/helpers/src/index.js";
export const TEST_CODE_IN_PRODUCTION = HELPER;
