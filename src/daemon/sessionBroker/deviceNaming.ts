import { BROKER_DEVICE_NAME_PREFIX } from "./persistedIdentity";

export { isProductBrokerDevice as isSessionBrokerDeviceName } from "./persistedIdentity";

/** Representative product-owned name for fakes; keep recognized prefixes private. */
export function exampleSessionBrokerDeviceName(suffix: string): string {
  return `${BROKER_DEVICE_NAME_PREFIX}${suffix}`;
}
