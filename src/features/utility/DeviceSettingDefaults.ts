import type { BootedDevice } from "../../models";
import {
  DEVICE_SETTING_KEYS,
  type DeviceSettingDefaultsPersistence,
  type DeviceSettingKey,
  type DeviceSettingValues,
} from "../../models/DeviceSettingDefaults";
import { registerBoundedAcquisitionCleanup } from "../../utils/boundedAcquisitionCleanup";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  registerDeviceIncarnationListener,
  type DeviceIncarnationListener,
} from "../../utils/deviceIncarnation";
import { pick } from "./DefaultDeviceSettingsAccess";
export { DefaultDeviceSettingsAccess } from "./DefaultDeviceSettingsAccess";

/** Reads and writes the settings on a device. */
export interface DeviceSettingsAccess {
  /** Current values of `keys`; a key the device cannot report is omitted. */
  read(
    device: BootedDevice,
    keys: readonly DeviceSettingKey[],
    signal?: AbortSignal,
  ): Promise<DeviceSettingValues>;
  /** Writes `values`; returns the keys that were written successfully. */
  write(device: BootedDevice, values: DeviceSettingValues): Promise<DeviceSettingKey[]>;
}

function recordedKeys(values: DeviceSettingValues): DeviceSettingKey[] {
  return DEVICE_SETTING_KEYS.filter((key) => key in values);
}

interface ResetFence {
  keys: Set<DeviceSettingKey>;
  sessionId: string;
}

/** Upper bound on a settings change waiting for the device's pending acquisition reset (#11145). */
export const PENDING_RESET_WAIT_MS = 15_000;

/**
 * Records device defaults before a session's first change of each setting, and resets the
 * changed settings when a different session next acquires the device (#11145).
 */
export class DeviceSettingDefaults {
  private readonly queues = new Map<string, Promise<void>>();
  /** Bumped when a different device takes over a serial: queued work of the old one is dropped. */
  private readonly identityEpochs = new Map<string, number>();
  /** Per device: keys a new owner changed while an acquisition reset was still running (#11254). */
  private readonly pendingResetFences = new Map<string, Set<ResetFence>>();

  private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout">;
  /** How long a settings change waits for the device's pending acquisition reset. */
  private readonly resetWaitMs: number;

  constructor(
    private readonly persistence: DeviceSettingDefaultsPersistence,
    private readonly access: DeviceSettingsAccess,
    /** The session holding a device, if any: only a session's changes are recorded. */
    private readonly holderOf: (deviceId: string) => string | null,
    {
      timer = defaultTimer,
      resetWaitMs = PENDING_RESET_WAIT_MS,
    }: { timer?: Pick<Timer, "setTimeout" | "clearTimeout">; resetWaitMs?: number } = {},
  ) {
    this.timer = timer;
    this.resetWaitMs = resetWaitMs;
  }

  /**
   * Record the current value of each of `keys` not yet recorded, before a session changes it.
   * Settles only after the device's pending acquisition reset, so the caller's change cannot race
   * it; the wait is bounded, and on timeout the caller proceeds with a warning.
   */
  recordBeforeChange(device: BootedDevice, keys: readonly DeviceSettingKey[]): Promise<void> {
    const sessionId = this.holderOf(device.deviceId);
    const abandoned = { value: false };
    const work =
      sessionId === null || keys.length === 0
        ? this.settled(device.deviceId)
        : this.enqueueRecord(device, keys, sessionId, abandoned);
    return this.awaitPendingReset(device.deviceId, work, sessionId, { abandoned, keys });
  }

  private async awaitPendingReset(
    deviceId: string,
    work: Promise<void>,
    sessionId: string | null,
    { abandoned, keys }: { abandoned: { value: boolean }; keys: readonly DeviceSettingKey[] },
  ): Promise<void> {
    try {
      await raceWithDeadline(work, {
        timer: this.timer,
        timeoutMs: this.resetWaitMs,
        label: `Reset of device settings on ${deviceId}`,
      });
    } catch (error) {
      // The caller changes the setting now: a record queued behind the reset would observe that
      // change instead of the device default.
      abandoned.value = true;
      // The reset is still running and would overwrite the change just made: fence these keys.
      if (sessionId !== null) {
        this.fenceKeys(deviceId, keys, sessionId);
      }
      logger.warn(
        `Proceeding with a settings change on ${deviceId} before its pending reset finished: ${errorMessage(error)}`,
        error,
      );
    }
  }

  private fenceKeys(deviceId: string, keys: readonly DeviceSettingKey[], sessionId: string): void {
    for (const fence of this.pendingResetFences.get(deviceId) ?? []) {
      for (const key of keys) {
        fence.keys.add(key);
      }
      fence.sessionId = sessionId;
    }
  }

  private enqueueRecord(
    device: BootedDevice,
    keys: readonly DeviceSettingKey[],
    sessionId: string,
    abandoned: { value: boolean },
  ): Promise<void> {
    return this.enqueue(device.deviceId, async () => {
      if (abandoned.value) {
        return;
      }
      const record = await this.persistence.get(device.deviceId);
      const known = record?.values ?? {};
      const missing = keys.filter((key) => !(key in known));
      const observed = missing.length > 0 ? await this.access.read(device, missing) : {};
      const values = { ...pick(observed, missing), ...known };
      if (recordedKeys(values).length === 0) {
        return;
      }
      if (record && record.sessionId === sessionId && recordedKeys(observed).length === 0) {
        return;
      }
      await this.persistence.put(device.deviceId, {
        platform: device.platform,
        name: device.name,
        sessionId,
        values,
      });
    });
  }

  /**
   * Reset every recorded setting whose current value differs from its default, when a session
   * other than the one that changed them acquires the device. A setting that fails to reset stays
   * recorded so the next acquisition tries again.
   */
  resetOnAcquisition(deviceId: string, sessionId: string): Promise<void> {
    const fence: ResetFence = { keys: new Set(), sessionId };
    const fences = this.pendingResetFences.get(deviceId) ?? new Set<ResetFence>();
    fences.add(fence);
    this.pendingResetFences.set(deviceId, fences);
    const done = this.enqueue(deviceId, () => this.runReset(deviceId, sessionId, fence));
    void done.then(() => {
      fences.delete(fence);
      if (fences.size === 0 && this.pendingResetFences.get(deviceId) === fences) {
        this.pendingResetFences.delete(deviceId);
      }
    });
    return done;
  }

  private async runReset(deviceId: string, sessionId: string, fence: ResetFence): Promise<void> {
    const record = await this.persistence.get(deviceId);
    if (!record || record.sessionId === sessionId) {
      return;
    }
    const device: BootedDevice = { deviceId, name: record.name, platform: record.platform };
    const keys = recordedKeys(record.values);
    const current = await this.access.read(device, keys);
    // Keys the new owner changed after the wait gave up are theirs now: leave them, but keep the
    // original default recorded under the new owner so the next acquisition resets them.
    const fenced = keys.filter((key) => fence.keys.has(key));
    const differing = keys.filter(
      (key) => !fence.keys.has(key) && (!(key in current) || current[key] !== record.values[key]),
    );
    const written =
      differing.length > 0 ? await this.access.write(device, pick(record.values, differing)) : [];
    const remaining = differing.filter((key) => !written.includes(key));
    const kept = [...remaining, ...fenced];
    if (kept.length === 0) {
      await this.persistence.delete(deviceId);
      return;
    }
    if (remaining.length > 0) {
      logger.warn(
        `Could not reset ${remaining.join(", ")} on ${deviceId} to the recorded device defaults; ` +
          "the next acquisition by another session retries",
      );
    }
    await this.persistence.put(deviceId, {
      ...record,
      ...(fenced.length > 0 ? { sessionId: fence.sessionId } : {}),
      values: pick(record.values, kept),
    });
  }

  /**
   * A different device now holds this serial: drop the predecessor's recorded defaults, and any
   * queued record or reset of its, so they are never written onto the new device.
   */
  forget(deviceId: string): Promise<void> {
    this.identityEpochs.set(deviceId, (this.identityEpochs.get(deviceId) ?? 0) + 1);
    return this.enqueue(deviceId, () => this.persistence.delete(deviceId), true);
  }

  /** Settles once the record/reset work queued for the device so far has finished. */
  settled(deviceId: string): Promise<void> {
    return this.queues.get(deviceId) ?? Promise.resolve();
  }

  private enqueue(
    deviceId: string,
    work: () => Promise<void>,
    survivesIdentityChange = false,
  ): Promise<void> {
    const previous = this.queues.get(deviceId) ?? Promise.resolve();
    const epoch = this.identityEpochs.get(deviceId) ?? 0;
    const next = previous
      .then(() =>
        survivesIdentityChange || (this.identityEpochs.get(deviceId) ?? 0) === epoch
          ? work()
          : undefined,
      )
      .catch((error: unknown) => {
        logger.warn(`Device setting defaults failed on ${deviceId}: ${errorMessage(error)}`, error);
      });
    this.queues.set(deviceId, next);
    void next.then(() => {
      if (this.queues.get(deviceId) === next) {
        this.queues.delete(deviceId);
      }
    });
    return next;
  }
}

let installed: Pick<DeviceSettingDefaults, "recordBeforeChange"> | undefined;

/** The daemon installs its recorder; without one (direct mode) nothing is recorded. */
export function installDeviceSettingDefaults(
  recorder: Pick<DeviceSettingDefaults, "recordBeforeChange"> | undefined,
): void {
  installed = recorder;
}

/**
 * Record device defaults before a tool changes `keys` on `device`. Never fails the caller: a
 * missing record only means the next owner may inherit the change.
 */
export async function recordDeviceSettingDefaultsBeforeChange(
  device: BootedDevice,
  keys: readonly DeviceSettingKey[],
): Promise<void> {
  try {
    await installed?.recordBeforeChange(device, keys);
  } catch (error) {
    logger.warn(
      `Failed to record device setting defaults on ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
  }
}

/**
 * The acquisition-time reset (#11145), run where acquisition cancels sessionless work. Tracked as
 * acquisition cleanup, like the other ownerless cleanups: the acquiring holder is not refused
 * while it runs. After release, the device is quarantined only until the reset settles or its
 * cap expires; bounding the tracked promise leaves the reset's queue and fences unchanged.
 */
export function createDeviceSettingDefaultsAcquisitionReset(
  manager: {
    registerAcquisitionDeviceCleanup(
      deviceId: string,
      cleanup: Promise<unknown>,
      capMs?: number,
    ): void;
  },
  defaults: Pick<DeviceSettingDefaults, "resetOnAcquisition">,
  timer: Pick<Timer, "setTimeout" | "clearTimeout"> = defaultTimer,
): (deviceId: string, sessionId: string) => void {
  return (deviceId, sessionId) => {
    registerBoundedAcquisitionCleanup(
      manager,
      deviceId,
      defaults.resetOnAcquisition(deviceId, sessionId),
      {
        timer,
        capMs: PENDING_RESET_WAIT_MS,
        label: `reset device setting defaults for session ${sessionId}`,
      },
    );
  };
}

export const DEVICE_SETTING_DEFAULTS_LISTENER_NAME = "device-setting-defaults";

/**
 * A different device now holds this serial (wipe, recreate, port reuse): the defaults recorded
 * for its predecessor must never be written onto it (#11145). Same-device incarnation changes keep
 * the record, since the guest's settings survive them.
 */
export function createDeviceSettingDefaultsIdentityListener(
  defaults: Pick<DeviceSettingDefaults, "forget">,
): DeviceIncarnationListener {
  return {
    name: DEVICE_SETTING_DEFAULTS_LISTENER_NAME,
    onDeviceIdentityReplaced: (deviceId) => {
      void defaults.forget(deviceId);
    },
    onDeviceIncarnationChanged: () => {},
  };
}

export function registerDeviceSettingDefaultsIdentityListener(
  defaults: Pick<DeviceSettingDefaults, "forget">,
): () => void {
  return registerDeviceIncarnationListener(createDeviceSettingDefaultsIdentityListener(defaults));
}
