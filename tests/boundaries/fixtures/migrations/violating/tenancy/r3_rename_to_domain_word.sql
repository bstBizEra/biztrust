-- Round three open finding 8, second half: the CREATE below is unremarkable -
-- "neutral" is not a domain word, and tenant_id is present, so it trips
-- neither M4 nor M5 - and the RENAME TO destination used to be invisible to
-- both rules, so a table built under an innocent name and renamed to a
-- domain word afterward walked straight past M4.
CREATE TABLE tenancy.neutral (
    id uuid,
    tenant_id uuid
);

ALTER TABLE tenancy.neutral RENAME TO claim;
