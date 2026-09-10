/**
 * @biztrust/identity-access - public contract.
 *
 * NOTHING HERE IS IMPLEMENTED. Token validation is epic P0.3 and the
 * organization-to-tenant mapping is P0.4; neither is authorised.
 *
 * Records: BIZTRUST-ARCH-001 section 8 (identity and authorization contract),
 * FLOWS.md section 3 (the tenant authorization sequence).
 */

import type { TenantId } from "@biztrust/tenancy";

export type SubjectId = string;
export type Scope = string;

/**
 * The result of the token chain of ARCH-001 section 8: signature, issuer,
 * expiry, audience, organization_id and scopes. Holding a validated token is
 * necessary and NOT sufficient for an authoritative insurance act - ADR-013
 * owns that distinction, and this contract must never be read as granting one.
 */
export interface ValidatedToken {
  readonly subject: SubjectId;
  readonly organizationId: string;
  readonly scopes: readonly Scope[];
  readonly issuer: string;
  readonly expiresAt: string;
}

export interface AuthorizationRequest {
  readonly token: ValidatedToken;
  readonly tenantId: TenantId;
  readonly operation: string;
  readonly resourceId: string | null;
}

/**
 * An allow or deny with the evidence the audit record needs. A denial is the
 * expected outcome of every negative control on the BT-G1 matrix.
 */
export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reason: string;
  readonly authorityReference: string | null;
  readonly decidedAt: string;
}

const NOT_IMPLEMENTED =
  "@biztrust/identity-access is a registered boundary with no implementation. " +
  "Token validation is epic P0.3 and tenant mapping is P0.4; neither is " +
  "authorised. See docs/architecture/STATUS.md.";

/** Query. Epic P0.3. */
export async function validateAccessToken(
  _rawToken: string,
): Promise<ValidatedToken> {
  throw new Error(NOT_IMPLEMENTED);
}

/** Query. Business authorization, the step after the resolver in FLOWS.md 3. */
export async function authorize(
  _request: AuthorizationRequest,
): Promise<AuthorizationDecision> {
  throw new Error(NOT_IMPLEMENTED);
}
