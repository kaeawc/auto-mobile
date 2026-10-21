/** Server-owned resource effects used by daemon lifecycle code. */
export interface DeviceResourceInvalidationHandlers {
  resetBootedDevicesResourceCache(): void;
  resetAndroidDeviceImageResourceCache(): void;
  notifyBootedDeviceResourcesUpdated(): Promise<void>;
}

let handlers: Partial<DeviceResourceInvalidationHandlers> = {};

/** Each supplied operation replaces its previous handler, leaving other operations intact. */
export function registerDeviceResourceInvalidation(
  registration: Partial<DeviceResourceInvalidationHandlers>,
): () => void {
  const previous = handlers;
  handlers = { ...handlers, ...registration };
  let restored = false;
  return () => {
    if (restored) {
      return;
    }
    restored = true;
    if (
      registration.resetBootedDevicesResourceCache &&
      handlers.resetBootedDevicesResourceCache === registration.resetBootedDevicesResourceCache
    ) {
      handlers.resetBootedDevicesResourceCache = previous.resetBootedDevicesResourceCache;
    }
    if (
      registration.resetAndroidDeviceImageResourceCache &&
      handlers.resetAndroidDeviceImageResourceCache ===
        registration.resetAndroidDeviceImageResourceCache
    ) {
      handlers.resetAndroidDeviceImageResourceCache = previous.resetAndroidDeviceImageResourceCache;
    }
    if (
      registration.notifyBootedDeviceResourcesUpdated &&
      handlers.notifyBootedDeviceResourcesUpdated ===
        registration.notifyBootedDeviceResourcesUpdated
    ) {
      handlers.notifyBootedDeviceResourcesUpdated = previous.notifyBootedDeviceResourcesUpdated;
    }
  };
}

export function resetBootedDevicesResourceCache(): void {
  handlers.resetBootedDevicesResourceCache?.();
}

export function resetAndroidDeviceImageResourceCache(): void {
  handlers.resetAndroidDeviceImageResourceCache?.();
}

export async function notifyBootedDeviceResourcesUpdated(): Promise<void> {
  await handlers.notifyBootedDeviceResourcesUpdated?.();
}

/** Clears every handler; the returned function puts back what was registered (e.g. by server modules). */
export function isolateDeviceResourceInvalidationForTesting(): () => void {
  const saved = handlers;
  handlers = {};
  return () => {
    handlers = saved;
  };
}
