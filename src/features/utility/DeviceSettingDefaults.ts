import type { BootedDevice, Platform } from "../../models";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import {
  DisplayConfig,
  type DisplayTheme,
  type SetDisplayConfigInput,
  type ThemeBaselineStore,
} from "./DisplayConfig";
import { SystemConfigurationManager } from "./SystemConfigurationManager";

/**
 * Display and system settings a session can change on a device (#11145). They are not restored
 * when the session releases the device; the next acquisition by a different session resets each
 * one that differs from the value recorded before any session first changed it.
 */
export const DEVICE_SETTING_KEYS = [
  "fontScale",
  "density",
  "nightMode",
  "locale",
  "timeFormat",
  "calendarSystem",
] as const;

export type DeviceSettingKey = (typeof DEVICE_SETTING_KEYS)[number];

/** A setting's value in the form its writer accepts back; `null` is an unset setting. */
export type DeviceSettingValue = string | number | null;

export type DeviceSettingValues = Partial<Record<DeviceSettingKey, DeviceSettingValue>>;

export interface DeviceSettingDefaultsRecord {
  platform: Platform;
  name: string;
  /** The session that most recently changed a recorded setting. */
  sessionId: string;
  /** Per setting: the value observed before any session first changed it. */
  values: DeviceSettingValues;
}

export interface DeviceSettingDefaultsPersistence {
  get(deviceId: string): Promise<DeviceSettingDefaultsRecord | null>;
  put(deviceId: string, record: DeviceSettingDefaultsRecord): Promise<void>;
  delete(deviceId: string): Promise<void>;
}

/** Reads and writes the settings on a device. */
export interface DeviceSettingsAccess {
  /** Current values of `keys`; a key the device cannot report is omitted. */
  read(device: BootedDevice, keys: readonly DeviceSettingKey[]): Promise<DeviceSettingValues>;
  /** Writes `values`; returns the keys that were written successfully. */
  write(device: BootedDevice, values: DeviceSettingValues): Promise<DeviceSettingKey[]>;
}

const DISPLAY_KEYS = ["fontScale", "density", "nightMode"] as const;

function pick(values: DeviceSettingValues, keys: readonly DeviceSettingKey[]): DeviceSettingValues {
  return Object.fromEntries(
    keys.filter((key) => key in values).map((key) => [key, values[key]]),
  ) as DeviceSettingValues;
}

function recordedKeys(values: DeviceSettingValues): DeviceSettingKey[] {
  return DEVICE_SETTING_KEYS.filter((key) => key in values);
}

/** Upper bound on a settings change waiting for the device's pending acquisition reset (#11145). */
export const PENDING_RESET_WAIT_MS = 15_000;

/**
 * Records device defaults before a session's first change of each setting, and resets the
 * changed settings when a different session next acquires the device (#11145).
 */
export class DeviceSettingDefaults {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly persistence: DeviceSettingDefaultsPersistence,
    private readonly access: DeviceSettingsAccess,
    /** The session holding a device, if any: only a session's changes are recorded. */
    private readonly holderOf: (deviceId: string) => string | null,
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout"> = defaultTimer,
    /** How long a settings change waits for the device's pending acquisition reset. */
    private readonly resetWaitMs: number = PENDING_RESET_WAIT_MS,
  ) {}

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
    return this.awaitPendingReset(device.deviceId, work, abandoned);
  }

  private async awaitPendingReset(
    deviceId: string,
    work: Promise<void>,
    abandoned: { value: boolean },
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
      logger.warn(
        `Proceeding with a settings change on ${deviceId} before its pending reset finished: ${errorMessage(error)}`,
        error,
      );
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
    return this.enqueue(deviceId, async () => {
      const record = await this.persistence.get(deviceId);
      if (!record || record.sessionId === sessionId) {
        return;
      }
      const device: BootedDevice = { deviceId, name: record.name, platform: record.platform };
      const keys = recordedKeys(record.values);
      const current = await this.access.read(device, keys);
      const differing = keys.filter(
        (key) => !(key in current) || current[key] !== record.values[key],
      );
      const written =
        differing.length > 0 ? await this.access.write(device, pick(record.values, differing)) : [];
      const remaining = differing.filter((key) => !written.includes(key));
      if (remaining.length === 0) {
        await this.persistence.delete(deviceId);
        return;
      }
      logger.warn(
        `Could not reset ${remaining.join(", ")} on ${deviceId} to the recorded device defaults; ` +
          "the next acquisition by another session retries",
      );
      await this.persistence.put(deviceId, { ...record, values: pick(record.values, remaining) });
    });
  }

  /** Settles once the record/reset work queued for the device so far has finished. */
  settled(deviceId: string): Promise<void> {
    return this.queues.get(deviceId) ?? Promise.resolve();
  }

  private enqueue(deviceId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(deviceId) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
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

/** Night mode written by a reset must not be taken for a displayConfig night-mode baseline. */
const unrecordedThemeBaselines: ThemeBaselineStore = {
  get: () => undefined,
  set: () => {},
  delete: () => {},
};

/** Reads and writes settings through DisplayConfig and SystemConfigurationManager. */
export class DefaultDeviceSettingsAccess implements DeviceSettingsAccess {
  constructor(private readonly adbFactory: AdbClientFactory = defaultAdbClientFactory) {}

  async read(
    device: BootedDevice,
    keys: readonly DeviceSettingKey[],
  ): Promise<DeviceSettingValues> {
    const values: DeviceSettingValues = {};
    if (keys.some((key) => (DISPLAY_KEYS as readonly string[]).includes(key))) {
      const display = await new DisplayConfig(device, {
        adbFactory: this.adbFactory,
      }).getRestorableConfig();
      Object.assign(values, {
        ...(display.fontScale !== undefined ? { fontScale: display.fontScale } : {}),
        ...(display.density !== undefined ? { density: display.density } : {}),
        ...(display.theme !== undefined ? { nightMode: display.theme } : {}),
      });
    }
    if (keys.some((key) => !(DISPLAY_KEYS as readonly string[]).includes(key))) {
      const settings = await new SystemConfigurationManager(
        device,
        this.adbFactory,
      ).getLocalizationSettings();
      if (settings.success) {
        Object.assign(values, {
          // Android locale changes are per app (API 33+) or need root and a framework restart
          // (older): only the iOS Simulator's device-wide locale is reset.
          ...(device.platform === "ios" && settings.locale ? { locale: settings.locale } : {}),
          ...(settings.timeFormat !== undefined ? { timeFormat: settings.timeFormat } : {}),
          ...(settings.calendarSystem ? { calendarSystem: settings.calendarSystem } : {}),
        });
      }
    }
    return pick(values, keys);
  }

  async write(device: BootedDevice, values: DeviceSettingValues): Promise<DeviceSettingKey[]> {
    const written: DeviceSettingKey[] = [];
    const display = displayInput(values);
    if (display.keys.length > 0) {
      const result = await new DisplayConfig(device, {
        adbFactory: this.adbFactory,
        themeBaselines: unrecordedThemeBaselines,
      }).setConfig(display.input);
      if (result.success) {
        written.push(...display.keys);
      } else {
        logger.warn(`Failed to reset display settings on ${device.deviceId}: ${result.error}`);
      }
    }
    const manager = new SystemConfigurationManager(device, this.adbFactory);
    if (typeof values.locale === "string") {
      const result = await manager.setLocale(values.locale, { broadcast: false });
      this.collect(result, "locale", device, written);
    }
    if ("timeFormat" in values) {
      if (await this.writeTimeFormat(device, manager, values.timeFormat ?? null)) {
        written.push("timeFormat");
      }
    }
    if (typeof values.calendarSystem === "string") {
      const result = await manager.setCalendarSystem(values.calendarSystem);
      this.collect(result, "calendarSystem", device, written);
    }
    return written;
  }

  private collect(
    result: { success: boolean; error?: string },
    key: DeviceSettingKey,
    device: BootedDevice,
    written: DeviceSettingKey[],
  ): void {
    if (result.success) {
      written.push(key);
    } else {
      logger.warn(`Failed to reset ${key} on ${device.deviceId}: ${result.error}`);
    }
  }

  private async writeTimeFormat(
    device: BootedDevice,
    manager: SystemConfigurationManager,
    value: DeviceSettingValue,
  ): Promise<boolean> {
    if (value === "12" || value === "24") {
      const result = await manager.set24HourFormat(value === "24");
      if (!result.success) {
        logger.warn(`Failed to reset timeFormat on ${device.deviceId}: ${result.error}`);
      }
      return result.success;
    }
    if (device.platform !== "android") {
      // No unset path on the iOS Simulator; the record is dropped rather than retried forever.
      logger.warn(`Cannot unset the 24-hour override on ${device.deviceId}; leaving it as is`);
      return true;
    }
    try {
      // An unset `time_12_24` follows the locale; deleting it restores that.
      await this.adbFactory
        .create(device)
        .executeCommand("shell settings delete system time_12_24");
      return true;
    } catch (error) {
      logger.warn(
        `Failed to unset timeFormat on ${device.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }
}

function displayInput(values: DeviceSettingValues): {
  input: SetDisplayConfigInput;
  keys: DeviceSettingKey[];
} {
  const input: SetDisplayConfigInput = {};
  const keys: DeviceSettingKey[] = [];
  if (typeof values.fontScale === "number" || values.fontScale === "default") {
    input.fontScale = values.fontScale;
    keys.push("fontScale");
  }
  if (typeof values.density === "number" || values.density === "default") {
    input.density = values.density;
    keys.push("density");
  }
  if (typeof values.nightMode === "string") {
    input.theme = values.nightMode as DisplayTheme;
    keys.push("nightMode");
  }
  return { input, keys };
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
 * while it runs, and a failure is logged and retried at the next acquisition, never quarantining
 * the device.
 */
export function createDeviceSettingDefaultsAcquisitionReset(
  manager: { registerAcquisitionDeviceCleanup(deviceId: string, cleanup: Promise<unknown>): void },
  defaults: Pick<DeviceSettingDefaults, "resetOnAcquisition">,
): (deviceId: string, sessionId: string) => void {
  return (deviceId, sessionId) => {
    manager.registerAcquisitionDeviceCleanup(
      deviceId,
      defaults.resetOnAcquisition(deviceId, sessionId),
    );
  };
}
