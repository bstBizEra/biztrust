/**
 * Internal to @biztrust/tenancy. Importable only from inside this module
 * (P0.2 dependency rule 1). The package exports field does not expose this
 * path, so an import from outside fails resolution with
 * ERR_PACKAGE_PATH_NOT_EXPORTED as well as failing the boundary check.
 *
 * Negative control 1 imports this path from another module and must see the
 * check name rule 1, the file and the import.
 *
 * There is no store. P0.6 designs the tenancy schema; this file holds the
 * shape the boundary test needs and nothing else.
 */

export interface TenantRow {
  readonly tenant_id: string;
  readonly organization_id: string;
  readonly created_at: string;
}

export const TENANCY_SCHEMA = "tenancy" as const;
