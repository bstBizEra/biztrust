-- SELECT ... INTO creates a table as a side effect of a query, in whatever
-- schema the target names. It was entirely unmodelled before this task.
SELECT * INTO audit.snapshot FROM tenancy.safe_table;
