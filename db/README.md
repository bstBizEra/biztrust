# db

Migrations, policies, seeds and row-level-security tests.

## Layout

```text
db/
├── migrations/<module>/   one directory per module that owns a schema
├── policies/              row-level security policies (epic P0.7)
└── seeds/                 synthetic fixtures only
```

## The rules the lint enforces

Run `pnpm lint:migrations`.

- **M1** a migration under `db/migrations/<module>/` creates, alters or drops
  objects in that module schema only.
- **M2** no foreign key crosses a schema boundary. Another module aggregate is
  referenced by its stable identifier, and the integrity of that reference is
  the owning module contract to keep.
- **M3** the audit schema is append-only: `UPDATE`, `DELETE`, `TRUNCATE`,
  `DROP`, a column drop and a type change are refused. A column add is allowed.
- **M4** P0 creates no domain table. A table named for `policy`, `client`,
  `claim` or `premium` means the phase has been left.
- **M5** every tenant-owned table carries `tenant_id`. A platform-owned table
  that genuinely is not tenant-owned says so with a `-- not-tenant-owned:`
  comment line, which the lint reads.
- **M6** a migration directory names a module registered in
  `modules/modules.yaml`.

## What exists

Two migrations, each creating an empty schema and nothing else. The tables of
the tenancy schema are epic P0.6 and the audit record is epic P0.10; neither is
authorised.
