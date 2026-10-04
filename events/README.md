# events

Versioned event contracts, AsyncAPI 3.1.0, over a CloudEvents profile.

**Reserved and empty.** The conventions are epic P0.9.

A domain event describes a completed business fact. A command request is not an
event, and an event does not grant another module authority to bypass its own
transition rules.

The envelope ARCH-001 section 12 requires, once P0.9 freezes it, carries
`event_id`, `event_type`, `event_version`, `occurred_at`, the
`effective_at_or_period` when the fact has valid-time effect, `recorded_at`,
`tenant_id`, `subject_type`, `subject_id`, `correlation_id`, `causation_id`,
`traceparent`, `producer`, and an `authority_reference` when the fact asserts
delegated or external authority.

External delivery is at-least-once unless a provider contract proves otherwise.
Consumers deduplicate by stable event identity and retain processing outcomes.
