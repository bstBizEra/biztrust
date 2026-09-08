-- Round three blocker: an apostrophe inside a quoted identifier used to make
-- scrub() blank everything up to the next apostrophe in the file.
CREATE TABLE tenancy."o'brien" (tenant_id uuid NOT NULL, id uuid PRIMARY KEY);
