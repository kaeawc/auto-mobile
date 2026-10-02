import { logger } from "../utils/logger";
import type { DeviceSessionRegistry } from "./deviceSessionRegistry";
import type { DeviceAdmissionGate } from "./deviceAdmissionGate";
import { ActionableError } from "../models/ActionableError";
import type { RetiredDeviceSession } from "./deviceSessionRegistry";

/** Restore retirement is distinct from an unknown or disconnected epoch. */
export class DeviceSessionSupersededByRestoreError extends ActionableError {
  readonly code = "DEVICE_SESSION_SUPERSEDED_BY_RESTORE";

  constructor(
    deviceSessionUuid: string,
    readonly retired: RetiredDeviceSession,
  ) {
    super(
      `deviceSessionUuid '${deviceSessionUuid}' was superseded by a snapshot restore. ` +
        "Get the current deviceSessionUuid from the deviceSnapshot restore result, the " +
        "device_session_started frame, daemon/listDeviceSessions, or the device description's runtime.deviceSessionUuid.",
    );
  }
}

/** Preserve the legacy text for unknown, disconnected, and quarantined UUIDs. */
export function unknownDeviceSessionError(deviceSessionUuid: string): ActionableError {
  return new ActionableError(
    `deviceSessionUuid '${deviceSessionUuid}' does not identify a live device session`,
  );
}

/** Add restore typing to existing wire errors without changing other envelopes. */
export function deviceSessionErrorFields(error: unknown): {
  code?: "DEVICE_SESSION_SUPERSEDED_BY_RESTORE";
} {
  return error instanceof DeviceSessionSupersededByRestoreError ? { code: error.code } : {};
}

/**
 * Bidirectional resolver between a device's mutable serial/UDID (`deviceId`) and
 * its daemon-minted `deviceSessionUuid` (the epic #5256 routing key).
 *
 * The push socket servers depend on this narrow contract rather than the whole
 * {@link DeviceSessionRegistry}: at push time they hold a `deviceId` and need the
 * live uuid to stamp the envelope; at subscribe time they hold a `deviceSessionUuid`
 * filter and need the current serial for the serial-scoped machinery (cadence
 * polling, telemetry backfill queries). A retired epoch resolves to `null` in both
 * directions, so a stale uuid can never re-attach to a reincarnated serial.
 */
export interface DeviceSessionResolver {
  /** Live `deviceSessionUuid` for a serial/UDID, or `null` when no epoch is live. */
  resolveUuid(deviceId: string): string | null;
  /** Live serial/UDID for a `deviceSessionUuid`, or `null` when the epoch is retired/unknown. */
  resolveDeviceId(deviceSessionUuid: string): string | null;
  /** Client-facing diagnosis for a UUID that failed live resolution. */
  getSessionError(
    deviceSessionUuid: string,
  ): ActionableError | DeviceSessionSupersededByRestoreError;
  /** Restore tombstone diagnosis only; other UUIDs remain valid push filters. */
  getRestoreSupersededError(
    deviceSessionUuid: string,
  ): DeviceSessionSupersededByRestoreError | undefined;
  /**
   * Whether this serial currently has NO routing identity because the pool's
   * entry for it is quarantined (`PooledDevice.identityUnresolved`): the serial
   * answers, but which runtime answers on it is unknown, so the epoch is
   * preserved and simply withheld.
   *
   * Distinguishes "quarantined" from "no live epoch", which `resolveUuid`
   * returning `null` cannot: a device-attributed frame for a serial with no
   * epoch is still broadcast to all-device subscribers, whereas a frame for a
   * quarantined serial is DROPPED — attributing it to the serial is the only
   * thing the daemon could do with it, and that attribution is exactly what is
   * in doubt (#6863 review).
   */
  isRoutingSuspended(deviceId: string): boolean;
  /**
   * FUNNEL 2, reached through the resolver a push server already holds: refuse a
   * device-addressed REQUEST whose serial is quarantined, rather than serving it
   * and silently dropping every frame it produces. Delegates to
   * `DevicePool.assertDeviceActionable`, so the refusal is the same one the tool
   * layer raises ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
   */
  assertDeviceActionable(deviceId: string, purpose: string): void;
}

/** The transport boundary needs retirement diagnostics, without serial routing. */
export function createDeviceSessionErrorResolver(registry: {
  getRetiredByUuid?(uuid: string): RetiredDeviceSession | undefined;
}): Pick<DeviceSessionResolver, "getSessionError" | "getRestoreSupersededError"> {
  const getRestoreSupersededError = (
    deviceSessionUuid: string,
  ): DeviceSessionSupersededByRestoreError | undefined => {
    const retired = registry.getRetiredByUuid?.(deviceSessionUuid);
    return retired
      ? new DeviceSessionSupersededByRestoreError(deviceSessionUuid, retired)
      : undefined;
  };
  return {
    getRestoreSupersededError,
    getSessionError: (deviceSessionUuid) =>
      getRestoreSupersededError(deviceSessionUuid) ?? unknownDeviceSessionError(deviceSessionUuid),
  };
}

/**
 * Null resolver — every lookup misses. The default in each push server before the
 * daemon wires the real registry, and a safe stand-in for unit tests that do not
 * exercise device-session routing: frames stamp `deviceSessionUuid: null` and only
 * all-device (`null`-filter) subscribers match.
 */
export const nullDeviceSessionResolver: DeviceSessionResolver = {
  resolveUuid: () => null,
  resolveDeviceId: () => null,
  getSessionError: unknownDeviceSessionError,
  getRestoreSupersededError: () => undefined,
  isRoutingSuspended: () => false,
  assertDeviceActionable: () => {},
};

/**
 * Adapt a {@link DeviceSessionRegistry} to the narrow {@link DeviceSessionResolver}
 * contract.
 *
 * `identityGate` is the device pool. Its `isPooledIdentityUnresolved` is the
 * `identityUnresolved` state: while it holds for a serial, BOTH directions
 * withhold the routing identity — the registry record is untouched, so a lifted
 * quarantine resumes the same epoch — and every device-attributed frame for that
 * serial is dropped by its push server. Its `assertDeviceActionable` is FUNNEL 2,
 * so a push server can REFUSE a device-addressed request instead of serving it
 * into a routing black hole. Omitted (direct mode, tests) means nothing is ever
 * quarantined.
 */
export interface DeviceIdentityGate extends DeviceAdmissionGate {
  isPooledIdentityUnresolved(deviceId: string): boolean;
}

const permissiveIdentityGate: DeviceIdentityGate = {
  isPooledIdentityUnresolved: () => false,
  assertDeviceActionable: () => {},
};

export function createRegistryDeviceSessionResolver(
  registry: DeviceSessionRegistry,
  identityGate: DeviceIdentityGate = permissiveIdentityGate,
): DeviceSessionResolver {
  const isIdentityQuarantined = (deviceId: string): boolean =>
    identityGate.isPooledIdentityUnresolved(deviceId);
  const resolveUuid = (deviceId: string): string | null =>
    isIdentityQuarantined(deviceId)
      ? null
      : (registry.getByDeviceId(deviceId)?.deviceSessionUuid ?? null);
  return {
    resolveUuid,
    ...createDeviceSessionErrorResolver(registry),
    resolveDeviceId: (deviceSessionUuid: string) => {
      const deviceId = registry.getByUuid(deviceSessionUuid)?.deviceId;
      if (deviceId === undefined || isIdentityQuarantined(deviceId)) {
        return null;
      }
      return deviceId;
    },
    isRoutingSuspended: isIdentityQuarantined,
    assertDeviceActionable: (deviceId: string, purpose: string) =>
      identityGate.assertDeviceActionable(deviceId, purpose),
  };
}

/**
 * Per-server memo that keeps a suspended serial's drop notice to ONCE per
 * quarantine instead of once per dropped frame — passive streams push
 * continuously, so the per-frame form would bury the log it belongs in.
 */
export class SuspendedDeviceRoutingLog {
  private readonly announced = new Set<string>();

  /**
   * Whether frames attributed to `deviceId` must be dropped. Logs the first drop
   * of a quarantine and re-arms as soon as routing resumes, so a later
   * re-quarantine of the same serial is announced again.
   */
  shouldDropFrame(resolver: DeviceSessionResolver, deviceId: string, serverLabel: string): boolean {
    if (!resolver.isRoutingSuspended(deviceId)) {
      this.announced.delete(deviceId);
      return false;
    }
    if (!this.announced.has(deviceId)) {
      this.announced.add(deviceId);
      logger.debug(
        `[${serverLabel}] Dropping frames for ${deviceId}: its pooled AVD identity is ` +
          "unresolved, so there is no routing identity to attribute them to",
      );
    }
    return true;
  }
}
