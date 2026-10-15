const SESSION_BROKER_DEVICE_NAME_PREFIXES = [
  "ambroker-",
  // amslot- is the legacy prefix still recognized for cleanup.
  "amslot-",
] as const;

export function isSessionBrokerDeviceName(name: string): boolean {
  return SESSION_BROKER_DEVICE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}
