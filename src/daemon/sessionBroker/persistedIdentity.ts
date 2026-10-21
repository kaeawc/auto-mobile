/** Persisted on-disk identity kept for upgrade compatibility. */
export const BINDINGS_COORDINATION_SCOPE = "managed-slots";
/** Only new device names use this prefix; a name alone is never deletion authority. */
export const BROKER_DEVICE_NAME_PREFIX = "ambroker-";
/** Retained for upgrade compatibility with devices created before the broker rename. */
export const LEGACY_DEVICE_NAME_PREFIX = "amslot-";

/** Product ownership includes legacy devices so upgrades cannot orphan native inventory. */
export function isProductBrokerDevice(name: string): boolean {
  return (
    typeof name === "string" &&
    (name.startsWith(BROKER_DEVICE_NAME_PREFIX) || name.startsWith(LEGACY_DEVICE_NAME_PREFIX))
  );
}

/** Durable role discriminating broker bindings from retired slot assignments. */
export const BROKER_BINDING_ROLE = "session-broker-device";
