# openapi

Contract-first HTTP API specifications, OpenAPI 3.2.0.

**Reserved and empty.** The conventions are epic P0.8 and the decision is
ADR-005, which is `DRAFT_REQUIRED`. This directory exists so that the
contract-first rule has a home before there is a contract to put in it.

The contract families ARCH-001 section 11 names:

```text
openapi/
├── biztrust-insurance-api.yaml
├── biztrust-payment-api.yaml
├── biztrust-partner-api.yaml
├── biztrust-admin-api.yaml
└── components/
    ├── common.yaml
    ├── errors.yaml
    ├── money.yaml
    ├── pagination.yaml
    └── insurance.yaml
```

The contract lint that will police them, rules L1 to L10, is the P0.8 design.
It is not in the CI skeleton because the work it checks does not exist.
