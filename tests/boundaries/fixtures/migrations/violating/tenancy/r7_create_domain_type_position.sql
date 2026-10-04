-- Round five ruling: the fifth TYPE_POSITIONS entry, the underlying type of a
-- CREATE DOMAIN. The domain itself is created in this directory's own schema,
-- so the only thing reported is the foreign type it is built on.
CREATE DOMAIN tenancy.note_grade AS audit.status_code;
