/** Internal to @biztrust/identity-access. Not exported by the package. */
export const TOKEN_CHAIN_STEPS = [
  "signature",
  "issuer",
  "expiry",
  "audience",
  "organization_id",
  "scopes",
] as const;
