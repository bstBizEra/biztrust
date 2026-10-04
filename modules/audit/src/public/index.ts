/**
 * @biztrust/audit - public contract.
 *
 * The write interface of this module IS its contract. No module inserts audit
 * rows directly (P0.2, "Authorization-sequence step"); that is what makes the
 * controls of the audit record enforceable in P0.10, and what the migration
 * lint protects by refusing UPDATE, DELETE, TRUNCATE, DROP, a column drop and
 * a type change on the audit schema.
 *
 * NOTHING HERE IS IMPLEMENTED. The audit framework is epic P0.10.
 *
 * Records: BIZTRUST-ARCH-001 section 15 (audit and observability),
 * AGENTS.md section 9 (evidence requirements).
 */

export type AuditRecordId = string;

/**
 * ARCH-001 section 15: every material action must be reconstructable. Logs and
 * traces must not expose secrets, raw credentials, unnecessary personal data or
 * cross-tenant information; that filtering is P0.10 and P0.11, not this shape.
 */
export interface AuditRecordInput {
  readonly tenantId: string;
  readonly legalEntityId: string | null;
  readonly actor: string;
  readonly operation: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly previousState: string | null;
  readonly resultingState: string | null;
  readonly authorizationDecision: "ALLOW" | "DENY";
  readonly authorityReference: string | null;
  readonly requestId: string;
  readonly traceparent: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly sourceRevision: string;
  readonly occurredAt: string;
}

const NOT_IMPLEMENTED =
  "@biztrust/audit is a registered boundary with no implementation. " +
  "The audit framework is epic P0.10; it is not authorised. " +
  "See docs/architecture/STATUS.md.";

/** Command. The one way an audit record is written. */
export async function record(
  _input: AuditRecordInput,
): Promise<AuditRecordId> {
  throw new Error(NOT_IMPLEMENTED);
}
