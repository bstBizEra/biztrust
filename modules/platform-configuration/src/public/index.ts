/**
 * @biztrust/platform-configuration - public contract.
 *
 * Registered by the P0.12 design rather than by the capability map of the
 * contract, which the registry shows in its source field as design:P0.12.
 *
 * NOTHING HERE IS IMPLEMENTED. Secrets and configuration are epic P0.12.
 *
 * A secret VALUE never crosses this boundary. The contract hands back a
 * reference that the runtime resolves, so that a secret cannot be logged by a
 * caller that did not know it held one.
 */

export type ConfigKey = string;

export interface SecretReference {
  readonly key: ConfigKey;
  readonly provider: string;
  readonly version: string;
}

export interface ConfigValue {
  readonly key: ConfigKey;
  readonly value: string;
  readonly source: "environment" | "file" | "provider";
}

const NOT_IMPLEMENTED =
  "@biztrust/platform-configuration is a registered boundary with no " +
  "implementation. Secrets and configuration are epic P0.12; it is not " +
  "authorised. See docs/architecture/STATUS.md.";

/** Query. Non-secret configuration only. */
export async function getConfig(_key: ConfigKey): Promise<ConfigValue> {
  throw new Error(NOT_IMPLEMENTED);
}

/** Query. Returns a reference, never a secret value. */
export async function requireSecretReference(
  _key: ConfigKey,
): Promise<SecretReference> {
  throw new Error(NOT_IMPLEMENTED);
}
