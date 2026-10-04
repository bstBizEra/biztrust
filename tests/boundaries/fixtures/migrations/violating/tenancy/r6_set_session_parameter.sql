-- The inversion behind finding C1: SET was the ONE entry on the
-- harmless-leading-verb list, kept there on the reasoning that a bare
-- `SET <parameter> = <value>` cannot reach another module's schema. There is
-- no such list any more - a statement this lint resolves no target from is
-- refused whatever verb it opens with - and this fixture is what fails if
-- anyone puts one back.
SET statement_timeout = '0';
