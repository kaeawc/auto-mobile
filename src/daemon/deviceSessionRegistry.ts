import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { logger } from "../utils/logger";
import type { Platform } from "../models";

/**
 * Identity of a single device *connection epoch*.
 *
 * The adb serial / simulator UDID (`deviceId`) is reused across boots and its
 * ADB `transportId` changes on reconnect, so a consumer cannot tell "same
 * device, stream continues" from "device rebooted, flush your caches" by serial
 * alone. `deviceSessionUuid` is minted once per epoch and retired when the
 * device disconnects, giving every stream a stable routing key that a reused
 * serial cannot alias.
 */
export interface DeviceSessionRecord {
  deviceSessionUuid: string;
  deviceId: string;
  platform: Platform;
  epochStartedAt: number;
}

/**
 * Input describing a device that has reached a boot-ready connection boundary.
 *
 * `incarnation` is the pool's monotonic per-connection counter
 * (`PooledDevice.incarnation`), assigned whenever the pool allocates a fresh
 * `PooledDevice`. It is the epoch boundary: keying the mint on it — rather than
 * on the presence of a prior `onDeviceDisconnected` — re-mints a same-serial
 * reconnect even when the disconnect monitor never confirmed the disappearance,
 * as long as the pool re-created the entry. (A restart so fast that the pool
 * never dropped the entry keeps the same incarnation and uuid — the pool
 * observed no boundary, so neither do we.)
 */
interface DeviceConnectedInput {
  deviceId: string;
  platform: Platform;
  incarnation: number;
}

interface LiveEntry {
  record: DeviceSessionRecord;
  incarnation: number;
}

/**
 * Observer of device-session epoch transitions.
 *
 * The daemon wires this to push `device_session_started` / `device_session_ended`
 * lifecycle frames onto the observation stream (epic #5256, item 3) so a consumer
 * flushes per-device state on a real epoch boundary instead of guessing from serial
 * reuse. A same-serial reincarnation surfaces as `onSessionEnded(old)` immediately
 * followed by `onSessionStarted(new)`.
 */
export interface DeviceSessionLifecycleListener {
  onSessionStarted(record: DeviceSessionRecord): void;
  onSessionEnded(record: DeviceSessionRecord): void;
}

/**
 * Process-lifetime map of `deviceId (serial/UDID) ↔ deviceSessionUuid`, the
 * single source of truth for device-session identity across the daemon's
 * stream API. Purely in-memory: an epoch is meaningless across daemon restarts,
 * so nothing here is persisted.
 */
export class DeviceSessionRegistry {
  private readonly timer: Timer;
  private readonly idGenerator: IdGenerator;
  private readonly byDeviceId = new Map<string, LiveEntry>();
  private readonly uuidToDeviceId = new Map<string, string>();
  private lifecycleListener: DeviceSessionLifecycleListener | null = null;

  constructor(timer: Timer = defaultTimer, idGenerator: IdGenerator = defaultIdGenerator) {
    this.timer = timer;
    this.idGenerator = idGenerator;
  }

  /**
   * Register (or clear, with `null`) the observer notified on epoch transitions.
   * Wired by the daemon after the observation-stream server is up.
   */
  setLifecycleListener(listener: DeviceSessionLifecycleListener | null): void {
    this.lifecycleListener = listener;
  }

  private emitStarted(record: DeviceSessionRecord): void {
    try {
      this.lifecycleListener?.onSessionStarted(record);
    } catch (error) {
      // A lifecycle observer must never break identity bookkeeping — swallow and
      // keep the registry authoritative; trace at debug for diagnosis.
      logger.debug(`[DeviceSessionRegistry] onSessionStarted listener threw: ${error}`);
    }
  }

  private emitEnded(record: DeviceSessionRecord): void {
    try {
      this.lifecycleListener?.onSessionEnded(record);
    } catch (error) {
      // See emitStarted: swallow observer faults, keep the registry authoritative.
      logger.debug(`[DeviceSessionRegistry] onSessionEnded listener threw: ${error}`);
    }
  }

  /**
   * Mint (or return the existing) device-session record for a connected device.
   *
   * Idempotent within an epoch: a repeated connect carrying the same
   * `incarnation` returns the existing record without minting. A changed
   * `incarnation` (reconnect, whether or not a disconnect was observed) retires
   * the superseded epoch and mints a fresh uuid.
   */
  onDeviceConnected(input: DeviceConnectedInput): DeviceSessionRecord {
    const existing = this.byDeviceId.get(input.deviceId);
    if (existing && existing.incarnation === input.incarnation) {
      return existing.record;
    }
    if (existing) {
      // Superseded epoch (new incarnation for the same serial) — drop its uuid
      // so a stale reference cannot resolve to the reincarnated device, and
      // surface the boundary as an end of the old epoch before the new one starts.
      this.uuidToDeviceId.delete(existing.record.deviceSessionUuid);
      this.emitEnded(existing.record);
    }

    const record: DeviceSessionRecord = {
      deviceSessionUuid: this.idGenerator.next(),
      deviceId: input.deviceId,
      platform: input.platform,
      epochStartedAt: this.timer.now(),
    };
    this.byDeviceId.set(input.deviceId, { record, incarnation: input.incarnation });
    this.uuidToDeviceId.set(record.deviceSessionUuid, input.deviceId);
    this.emitStarted(record);
    return record;
  }

  /** Retire the live epoch for a disconnected device, if any. */
  onDeviceDisconnected(deviceId: string): void {
    const existing = this.byDeviceId.get(deviceId);
    if (!existing) {
      return;
    }
    this.byDeviceId.delete(deviceId);
    this.uuidToDeviceId.delete(existing.record.deviceSessionUuid);
    this.emitEnded(existing.record);
  }

  getByDeviceId(deviceId: string): DeviceSessionRecord | undefined {
    return this.byDeviceId.get(deviceId)?.record;
  }

  getByUuid(deviceSessionUuid: string): DeviceSessionRecord | undefined {
    const deviceId = this.uuidToDeviceId.get(deviceSessionUuid);
    if (deviceId === undefined) {
      return undefined;
    }
    return this.byDeviceId.get(deviceId)?.record;
  }

  /** All currently-live device sessions. */
  list(): DeviceSessionRecord[] {
    const records: DeviceSessionRecord[] = [];
    for (const entry of this.byDeviceId.values()) {
      records.push(entry.record);
    }
    return records;
  }
}
