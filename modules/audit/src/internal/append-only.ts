/** Internal to @biztrust/audit. Not exported by the package. */
export const AUDIT_SCHEMA = "audit" as const;
export const FORBIDDEN_ON_AUDIT = ["UPDATE", "DELETE", "TRUNCATE", "DROP"] as const;
