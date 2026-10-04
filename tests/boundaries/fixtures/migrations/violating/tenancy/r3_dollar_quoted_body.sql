-- A body this lint cannot read is refused, not passed.
DO $$ BEGIN PERFORM 1; END $$;
