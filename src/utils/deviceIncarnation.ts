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
export type DeviceIncarnationBumper = (deviceId: string) => boolean;

/** One owner of state keyed by a device serial. */
export interface DeviceIncarnationListener {
  readonly name: string;
  /**
   * Quiesce host state while the current guest is still alive. VM snapshot
   * loading rewinds guest processes, so owners such as screen recording must
   * stop them before the console load command rather than after it completes.
   */
  prepareForIncarnationChange?(deviceId: string): Promise<void> | void;
  onDeviceIncarnationChanged(deviceId: string): Promise<void> | void;
}

let resolver: DeviceIncarnationResolver | undefined;
let bumper: DeviceIncarnationBumper | undefined;
const directModeIncarnations = new Map<string, number>();
const listeners = new Map<string, DeviceIncarnationListener>();

/**
 * Register (or, with `undefined`, clear) the process-wide resolver. The daemon
 * calls this once with its pool; tests call it to control the epoch explicitly
 * and must clear it again so the token does not leak between cases.
 */
export function setDeviceIncarnationResolver(next: DeviceIncarnationResolver | undefined): void {
  resolver = next;
  if (next === undefined) {
    directModeIncarnations.clear();
  }
}

/** Register the daemon's pooled-device bump primitive, or clear it at shutdown. */
export function setDeviceIncarnationBumper(next: DeviceIncarnationBumper | undefined): void {
  bumper = next;
}

/**
 * Advance a serial's incarnation. Pooled devices use DevicePool's counter;
 * direct mode retains a process-local counter so restore still fences caches.
 */
export function advanceDeviceIncarnation(deviceId: string): string {
  if (bumper?.(deviceId)) {
    return deviceIncarnationToken(deviceId) ?? "unknown";
  }
  const next = (directModeIncarnations.get(deviceId) ?? 0) + 1;
  directModeIncarnations.set(deviceId, next);
  return String(next);
}

/** Register a per-serial cache owner. Re-registering a name replaces its owner. */
export function registerDeviceIncarnationListener(listener: DeviceIncarnationListener): () => void {
  listeners.set(listener.name, listener);
  return () => {
    if (listeners.get(listener.name) === listener) {
      listeners.delete(listener.name);
    }
  };
}

/** Snapshot the module-init listener inventory for the restore invalidation funnel. */
export function getDeviceIncarnationListeners(): readonly DeviceIncarnationListener[] {
  return [...listeners.values()];
}

/**
 * The current connection-epoch token for `deviceId`, or `undefined` when no
 * resolver is registered or the device is not pooled. Stringified so consumers
 * can compare and log it without caring that it is a counter.
 */
export function deviceIncarnationToken(deviceId: string): string | undefined {
  const incarnation = resolver?.(deviceId) ?? directModeIncarnations.get(deviceId);
  return incarnation === undefined ? undefined : String(incarnation);
}
