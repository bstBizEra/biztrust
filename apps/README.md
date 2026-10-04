# apps

Broker, admin and partner experiences.

**Empty in P0.** The stack decision shipped no UI until the P0.13 epic added the
control plane to the plan, and the P0.13 design places it here after its proof.
Nothing else belongs in P0.

Dependency rule 5: an experience imports module contracts and `packages/*`, and
nothing imports an experience.

Dependency rule 7 is narrower for one directory. `apps/control-plane` imports
`packages/*` and **no** module contract, because a contract call runs in the
calling process and would pass the token chain, the tenant resolver and the
audit by. That surface reaches the platform through the admin API alone, with
an outbound host allow-list checked in CI and at runtime.
