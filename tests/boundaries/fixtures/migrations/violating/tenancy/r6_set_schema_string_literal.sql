-- Round four finding C1. PostgreSQL documents `SET SCHEMA 'value'` as an
-- alias for `SET search_path TO value`. scrub() blanks the string literal
-- before any matcher runs, so this statement reduced to `set schema ''`: the
-- SET SCHEMA extractor found no identifier, the search_path refusal found no
-- literal `search_path`, and SET was on a list of leading verbs presumed
-- harmless. This file - with two more statements after it whose every
-- unqualified name would bind into `audit` at run time - reported
-- MIGRATION_LINT PASS with exit 0. The invalid unquoted spelling
-- (`SET SCHEMA audit`) was caught all along; only the legal one escaped.
SET SCHEMA 'audit';
