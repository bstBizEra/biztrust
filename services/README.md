# services

API and worker entry points.

Dependency rule 5: an entry point imports module **contracts** and `packages/*`,
and nothing imports an entry point.

| Service | What it is |
|---|---|
| `api` | The HTTP entry point. There is no server, no route and no listener. It names the tenant authorization sequence of FLOWS.md section 3 in order, and every step it would call throws. API conventions are epic P0.8; the chain it owes every protected request is P0.3, P0.4 and P0.7 |
