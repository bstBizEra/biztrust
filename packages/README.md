# packages

Shared contracts and observability. No domain code, and in this design no UI.

Dependency rule 4: `packages/*` may be imported by any module and may import
**no** module. A package that needs a module type has found domain code in the
wrong place, and the boundary check says so by name.

| Package | What it is |
|---|---|
| `contracts` | The domain-free primitives of ARCH-001 section 11: problem details, money as a decimal string plus a currency code, RFC 3339 timestamps, UUIDv7, the bitemporal shape ADR-015 requires, and the canonical HTTP header names |
| `observability` | The observability seam. Unimplemented; the baseline is epic P0.11 |
