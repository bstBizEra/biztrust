/**
 * The seven dependency rules of the P0.2 design, built FROM a module registry.
 *
 * Separate from the generator so that the boundary test suite can build the
 * same rules from a FIXTURE registry and run the checker over a fixture
 * workspace. A suite that tested the generator against the real registry would
 * only prove the generator agrees with itself; the fixture holds one
 * deliberately violating import per rule and one conforming import per rule,
 * and asserts that each violation is reported with its rule name and each
 * conforming import is not.
 */

/** Escapes a module name for embedding in a regular expression literal. */
export function rx(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildRules(registry) {
  const packaged = registry.modules.filter((m) => m.package === true);
  const rules = [];

  // Rule 1. A module's internals are private.
  for (const m of packaged) {
    rules.push({
      name: `rule-1-internals-private-${m.name}`,
      comment:
        `Rule 1: anything under modules/${m.name}/src/internal/ may be imported ` +
        `only from inside modules/${m.name}/. The package exports field refuses ` +
        `the path at resolution as well; this rule catches an absolute path, ` +
        `against which exports "is not a strong encapsulation".`,
      severity: "error",
      from: { pathNot: `^modules/${rx(m.name)}/` },
      to: { path: `^modules/${rx(m.name)}/src/internal/` },
    });
  }

  // Rule 2. Modules depend on contracts.
  for (const m of packaged) {
    rules.push({
      name: `rule-2-contracts-only-${m.name}`,
      comment:
        `Rule 2: modules/${m.name} may import another module only through ` +
        `@biztrust/<module>, which resolves to that module's contract, ` +
        `src/public/index.ts. Never a repository, a table or a connection.`,
      severity: "error",
      from: { path: `^modules/${rx(m.name)}/` },
      to: {
        path: "^modules/(?!" + rx(m.name) + "/)[^/]+/src/",
        pathNot: "^modules/[^/]+/src/public/index\\.ts$",
      },
    });
  }

  // Rule 3. No cycles.
  rules.push({
    name: "rule-3-no-cycles",
    comment:
      "Rule 3: the module dependency graph is acyclic. A pair of modules that " +
      "need each other is one module or a missing contract.",
    severity: "error",
    from: { path: "^modules/" },
    to: { circular: true },
  });

  // Rule 4. Shared code is not domain code.
  rules.push({
    name: "rule-4-packages-import-no-module",
    comment:
      "Rule 4: packages/* may be imported by any module and may import no " +
      "module. A package that needs a module's type has found domain code in " +
      "the wrong place.",
    severity: "error",
    from: { path: "^packages/" },
    to: { path: "^modules/" },
  });

  // Rule 5. Entry points and experiences see contracts only, and nothing
  // imports an entry point or an experience.
  rules.push({
    name: "rule-5-entry-points-see-contracts-only",
    comment:
      "Rule 5: services/* and apps/* import modules' contracts and packages/*; " +
      "an import of any other path inside a module is a bypass of the contract.",
    severity: "error",
    from: { path: "^(services|apps)/" },
    to: {
      path: "^modules/[^/]+/src/",
      pathNot: "^modules/[^/]+/src/public/index\\.ts$",
    },
  });
  rules.push({
    name: "rule-5-nothing-imports-an-entry-point",
    comment: "Rule 5, second half: nothing imports services/* or apps/*.",
    severity: "error",
    from: { pathNot: "^(services|apps)/" },
    to: { path: "^(services|apps)/" },
  });

  // Rule 6. Test packages stay in tests.
  rules.push({
    name: "rule-6-test-packages-stay-in-tests",
    comment:
      "Rule 6: anything under tests/ may be imported only from tests/. The rule " +
      "exists so that the P0.7 bypass entry point, a test-only package that runs " +
      "a statement as the application role with no authorization, cannot reach a " +
      "running service.",
    severity: "error",
    from: { pathNot: "^tests/" },
    to: { path: "^tests/" },
  });

  // Rule 7. The control plane sees packages only.
  rules.push({
    name: "rule-7-control-plane-sees-packages-only",
    comment:
      "Rule 7: apps/control-plane imports packages/* and no module's contract, " +
      "narrower than rule 5, because a contract call runs in the calling process " +
      "and would pass the P0.3 chain, the P0.4 resolver and the audit by. The " +
      "surface reaches the platform through the admin API alone.",
    severity: "error",
    from: { path: "^apps/control-plane/" },
    to: { path: "^modules/" },
  });

  return rules;
}

