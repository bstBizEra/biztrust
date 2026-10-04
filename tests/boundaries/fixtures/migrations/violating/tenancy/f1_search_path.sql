-- One violation only: setting search_path so an unqualified name resolves
-- somewhere the lint cannot predict.
SET search_path TO audit;
