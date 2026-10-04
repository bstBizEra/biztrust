/**
 * Internal to @biztrust/tenancy. Importable only from inside this module
 * (P0.2 dependency rule 1). The package exports field does not expose this
 * path, so Node also refuses an import from outside, but with an error that
 * depends on the importer: ERR_PACKAGE_PATH_NOT_EXPORTED where the importer
 * declares a dependency on @biztrust/tenancy (services/api), and
 * ERR_MODULE_NOT_FOUND where it does not (modules/audit, packages/contracts).
 * Neither error is the control. The boundary check is, and it names the rule
 * for both forms, relative path and package name (rules 1 and 1-by-name).
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
