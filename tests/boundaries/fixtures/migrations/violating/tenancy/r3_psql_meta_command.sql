-- A psql meta-command carries no SQL verb at all. A psql-driven runner
-- executes this line directly, including running a second file this lint
-- never reads, so it is refused rather than silently ignored.
\i ../../../elsewhere/drop.sql
