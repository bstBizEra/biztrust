/**
 * @biztrust/service-api - the HTTP entry point.
 *
 * P0.2 dependency rule 5: an entry point imports the CONTRACTS of modules and
 * shared packages, and nothing imports an entry point. It never imports a
 * module internal; negative control 3 proves that by trying.
 *
 * NOTHING HERE IS IMPLEMENTED. There is no server, no route and no listener.
 * API conventions are epic P0.8; the authorization chain the entry point owes
 * every protected request is P0.3, P0.4 and P0.7.
 */

import { resolveTenantByOrganization } from "@biztrust/tenancy";
import { validateAccessToken, authorize } from "@biztrust/identity-access";
import { record } from "@biztrust/audit";
import { PROBLEM_CONTENT_TYPE } from "@biztrust/contracts";

/**
 * The order of the tenant authorization sequence (FLOWS.md section 3), written
 * out so that a reader can see which epic owns each step. Calling it throws:
 * every step below is unimplemented.
 */
export const AUTHORIZATION_SEQUENCE = [
  "user-or-service",
  "organization-token",
  "gateway-candidate",
  "api-boundary",
  "organization-to-tenant-resolver",
  "business-authorization",
  "row-level-security",
  "audit-and-observability",
  "allow-or-deny-with-evidence",
] as const;

export const ERROR_CONTENT_TYPE = PROBLEM_CONTENT_TYPE;

/**
 * The shape of a protected request, referenced so that the imports above are
 * real edges in the dependency graph the boundary check reads. It is not a
 * handler and it is not wired to a server.
 */
export async function handleProtectedRequest(
  rawToken: string,
  organizationId: string,
  operation: string,
): Promise<never> {
  const token = await validateAccessToken(rawToken);
  const tenant = await resolveTenantByOrganization(organizationId);
  if (tenant === null) {
    throw new Error("no tenant for organization");
  }
  const decision = await authorize({
    token,
    tenantId: tenant.tenantId,
    operation,
    resourceId: null,
  });
  await record({
    tenantId: tenant.tenantId,
    legalEntityId: tenant.legalEntityId,
    actor: token.subject,
    operation,
    resourceType: "unknown",
    resourceId: null,
    previousState: null,
    resultingState: null,
    authorizationDecision: decision.allowed ? "ALLOW" : "DENY",
    authorityReference: decision.authorityReference,
    requestId: "unset",
    traceparent: "unset",
    correlationId: "unset",
    causationId: null,
    sourceRevision: "unset",
    occurredAt: new Date().toISOString(),
  });
  throw new Error("no request handling is implemented in P0");
}
