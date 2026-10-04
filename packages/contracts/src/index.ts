/**
 * @biztrust/contracts - shared, domain-free primitives.
 *
 * P0.2 dependency rule 4: shared code is not domain code. This package may be
 * imported by any module and may import NO module. A package that needs the
 * type of a module has found domain code in the wrong place.
 *
 * The baseline here is the one ARCH-001 section 11 proposes and P0.8 freezes.
 */

/** RFC 9457 problem details. ARCH-001 section 11: the error format. */
export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
}

/**
 * ARCH-001 section 11: money is a decimal STRING plus an ISO currency code.
 * A binary float never represents money in this platform.
 */
export interface Money {
  readonly amount: string;
  readonly currency: string;
}

/** RFC 3339 UTC timestamp. */
export type Timestamp = string;

/** ISO YYYY-MM-DD calendar date. */
export type CalendarDate = string;

/** UUIDv7 where ordered identifiers are beneficial (RFC 9562). */
export type Uuid = string;

/**
 * ADR-015 keeps valid time and record time distinct for coverage-sensitive and
 * financial-effective facts; a correction never erases the prior assertion.
 */
export interface Bitemporal {
  readonly effectiveFrom: Timestamp;
  readonly effectiveTo: Timestamp | null;
  readonly effectiveTimezone: string;
  readonly recordedAt: Timestamp;
  readonly supersedesId: Uuid | null;
}

/** The canonical HTTP header names of ARCH-001 section 11. */
export const HTTP_HEADERS = {
  requestId: "X-Request-ID",
  traceparent: "traceparent",
  idempotencyKey: "Idempotency-Key",
  ifMatch: "If-Match",
  etag: "ETag",
} as const;

export const PROBLEM_CONTENT_TYPE = "application/problem+json" as const;
