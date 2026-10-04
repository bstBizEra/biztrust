-- not-tenant-owned: this first table genuinely is platform-owned.
CREATE TABLE tenancy.platform_registry (id uuid PRIMARY KEY, label text);
-- The marker above must NOT exempt this one.
CREATE TABLE tenancy.customer_data (id uuid PRIMARY KEY, secret text);
