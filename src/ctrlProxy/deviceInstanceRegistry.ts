/**
 * The per-device instance registry shape shared by the CtrlProxy managers and
 * clients (#11847). It is deliberately the `Map` subset those classes already use,
 * so a test may still swap or seed a plain `Map` through the class's static
 * `instances` field while production code goes through the helpers below.
 */
export type DeviceInstanceRegistry<T> = Pick<
  Map<string, T>,
  "get" | "set" | "has" | "delete" | "clear" | "values" | "entries"
>;

/**
 * Return the instance registered for `deviceId`, creating and registering it with
 * `create` only when none exists. `create` runs at most once and only on a miss, so
 * constructor-time side effects stay exactly where they were.
 */
export function getOrCreateDeviceInstance<T>(
  registry: DeviceInstanceRegistry<T>,
  deviceId: string,
  create: () => T,
): T {
  const existing = registry.get(deviceId);
  if (existing !== undefined) {
    return existing;
  }
  const created = create();
  registry.set(deviceId, created);
  return created;
}

/**
 * Drop `deviceId` only while `instance` is still the registered one, so a stale
 * holder cannot evict the replacement a newer caller registered.
 */
export function deleteDeviceInstanceIfCurrent<T>(
  registry: DeviceInstanceRegistry<T>,
  deviceId: string,
  instance: T,
): boolean {
  if (registry.get(deviceId) !== instance) {
    return false;
  }
  registry.delete(deviceId);
  return true;
}
