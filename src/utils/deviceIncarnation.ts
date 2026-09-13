/**
 * Process-local access to the device pool's connection-epoch counter.
 *
 * `PooledDevice.incarnation` is the ONLY epoch token in the device identity
 * model: an adb serial is reused across boots, and a discovery listing carries
 * nothing that distinguishes one occupant of `emulator-5554` from the next.
 * Anything that caches per-device state keyed on the serial therefore has to key
 * on the incarnation as well, or a same-serial reincarnation silently inherits
 * the previous device's cached state (issue #3351).
 *
 * Feature code must not reach into the daemon to ask, so the daemon registers a
 * resolver here when it wires its pool (`DaemonState.initialize`) and callers
 * read the token through {@link deviceIncarnationToken}. Outside a daemon -- a
 * direct-mode invocation, or a unit test that never built a pool -- no resolver
 * is registered and the token is `undefined`, which every consumer must treat as
 * "no epoch information", never as an epoch of its own.
 */
export type DeviceIncarnationResolver = (deviceId: string) => number | undefined;

let resolver: DeviceIncarnationResolver | undefined;

/**
 * Register (or, with `undefined`, clear) the process-wide resolver. The daemon
 * calls this once with its pool; tests call it to control the epoch explicitly
 * and must clear it again so the token does not leak between cases.
 */
export function setDeviceIncarnationResolver(next: DeviceIncarnationResolver | undefined): void {
  resolver = next;
}

/**
 * The current connection-epoch token for `deviceId`, or `undefined` when no
 * resolver is registered or the device is not pooled. Stringified so consumers
 * can compare and log it without caring that it is a counter.
 */
export function deviceIncarnationToken(deviceId: string): string | undefined {
  const incarnation = resolver?.(deviceId);
  return incarnation === undefined ? undefined : String(incarnation);
}
