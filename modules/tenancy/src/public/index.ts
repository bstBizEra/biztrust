/**
 * @biztrust/tenancy - public contract.
 *
 * This file is the ONLY path another package may import from this module
 * (P0.2 dependency rule 2). What a contract exports is the commands, queries,
 * published event types and identifier types of the module. It never exports a
 * repository, a table or a connection.
 *
 * NOTHING HERE IS IMPLEMENTED. Every operation throws. The module exists so
 * that the boundary around it can be tested before the behaviour inside it is
 * designed; the tenancy data model is P0.6 and tenant provisioning is P0.5.
 *
 * Records: BIZTRUST-ARCH-001 section 7 (tenancy contract), DOMAIN_MODEL.md
 * section 6 (tenant-owned record baseline).
 */

export type TenantId = string;
export type LegalEntityId = string;
export type BusinessUnitId = string;
export type OrganizationId = string;

/**
 * The resolved tenant security context. ARCH-001 INV-002: tenant authority
 * originates from validated identity context, never an untrusted client
 * identifier alone. An organization or tenant identifier in a URL, header,
 * query string or body is requested context only.
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly organizationId: OrganizationId;
  readonly legalEntityId: LegalEntityId | null;
  readonly resolvedAt: string;
}

export interface ProvisionTenantInput {
  readonly organizationId: OrganizationId;
  readonly displayName: string;
  readonly requestedBy: string;
}

/** Published fact. Envelope fields are ARCH-001 section 12; P0.9 freezes them. */
export interface TenantProvisioned {
  readonly eventType: "biztrust.tenancy.tenant.provisioned";
  readonly eventVersion: 1;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
}

const NOT_IMPLEMENTED =
  "@biztrust/tenancy is a registered boundary with no implementation. " +
  "The tenancy data model is epic P0.6 and provisioning is P0.5; neither is " +
  "authorised. See docs/architecture/STATUS.md.";

/** Query. Resolves an identity organization to a BizTrust tenant (epic P0.4). */
export async function resolveTenantByOrganization(
  _organizationId: OrganizationId,
): Promise<TenantContext | null> {
  throw new Error(NOT_IMPLEMENTED);
}

/** Query. */
export async function getTenant(_tenantId: TenantId): Promise<TenantContext> {
  throw new Error(NOT_IMPLEMENTED);
}

/** Command. */
export async function provisionTenant(
  _input: ProvisionTenantInput,
): Promise<TenantProvisioned> {
  throw new Error(NOT_IMPLEMENTED);
}
