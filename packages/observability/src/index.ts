/**
 * @biztrust/observability - the observability seam.
 *
 * Rule 4 applies: this package imports no module.
 *
 * NOTHING HERE IS IMPLEMENTED. The observability baseline is epic P0.11, whose
 * reconstruction test and attribute allow-list run in their own CI job.
 *
 * ARCH-001 section 15: logs and traces must not expose secrets, raw
 * credentials, unnecessary personal data or cross-tenant information. The
 * allow-list that enforces that is P0.11 and is not present here.
 */

export interface SpanAttributes {
  readonly [key: string]: string | number | boolean;
}

export interface Logger {
  info(message: string, attributes?: SpanAttributes): void;
  warn(message: string, attributes?: SpanAttributes): void;
  error(message: string, attributes?: SpanAttributes): void;
}

const NOT_IMPLEMENTED =
  "@biztrust/observability is a seam with no implementation. The " +
  "observability baseline is epic P0.11; it is not authorised. " +
  "See docs/architecture/STATUS.md.";

export function getLogger(_name: string): Logger {
  throw new Error(NOT_IMPLEMENTED);
}

/** W3C Trace Context. The header name lives in @biztrust/contracts. */
export function currentTraceparent(): string {
  throw new Error(NOT_IMPLEMENTED);
}
