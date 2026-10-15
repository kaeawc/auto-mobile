// REBASE NOTE: work/12495-remove-device-slots adds isProductBrokerDevice in persistedIdentity.ts.
// After rebasing onto it, replace this module's body with
// `export { isProductBrokerDevice as isSessionBrokerDeviceName } from "./persistedIdentity";`.
const SESSION_BROKER_DEVICE_NAME_PREFIXES = [
  "ambroker-",
  // amslot- is the legacy prefix still recognized for cleanup.
  "amslot-",
] as const;

export function isSessionBrokerDeviceName(name: string): boolean {
  return SESSION_BROKER_DEVICE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Representative product-owned name for fakes; keep recognized prefixes private. */
export function exampleSessionBrokerDeviceName(suffix: string): string {
  return `${SESSION_BROKER_DEVICE_NAME_PREFIXES[0]}${suffix}`;
}
