import type { BootedDevice } from "../../models";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import {
  AdbEmulatorSensorConsole,
  formatEmulatorSensorValue,
  type EmulatorSensorConsole,
  type EmulatorSensorName,
} from "./EmulatorSensors";

/** Bound on each best-effort sensor write while restoring, as `Shake` bounds its restore. */
export const EMULATOR_SENSOR_RESTORE_TIMEOUT_MS = 1_000;

/** The values a device's sensors held before `setSensor` first changed them. */
export interface EmulatorSensorRestoreEntry {
  device: BootedDevice;
  /** The session whose release restores the entry; undefined while only sessionless calls wrote. */
  owner?: string;
  originals: Map<EmulatorSensorName, number[]>;
}

export type EmulatorSensorConsoleFactory = (device: BootedDevice) => EmulatorSensorConsole;

export const defaultEmulatorSensorConsoleFactory: EmulatorSensorConsoleFactory = (device) =>
  new AdbEmulatorSensorConsole(defaultAdbClientFactory.create(device));

/**
 * Per-device, write-once record of each sensor's value before the first change
 * (#14114). In memory only: a daemon restart loses it, and the emulator keeps
 * whatever was last set until it is cold-booted.
 *
 * A session that writes a sensor takes ownership of the device's entry, so its
 * release restores every sensor recorded there, including any a sessionless call
 * changed first: the device goes back to the values found before AutoMobile
 * touched it. An entry only sessionless calls wrote stays until `reset`.
 */
export class EmulatorSensorRestoreRegistry {
  private readonly entries = new Map<string, EmulatorSensorRestoreEntry>();

  /** The value `reset` and release restore for `sensor`, if one is recorded. */
  original(deviceId: string, sensor: EmulatorSensorName): number[] | undefined {
    return this.entries.get(deviceId)?.originals.get(sensor);
  }

  /** Whether a session release will restore this device's recorded sensors. */
  restoresOnRelease(deviceId: string): boolean {
    return this.entries.get(deviceId)?.owner !== undefined;
  }

  /**
   * Record `value` as the sensor's original unless one is already recorded, and
   * hand the entry to `owner` when a session is writing. Returns true when this
   * call recorded the value, so a refused write can take it back with `forget`.
   */
  record(
    device: BootedDevice,
    sensor: EmulatorSensorName,
    value: readonly number[],
    owner: string | undefined,
  ): boolean {
    const entry: EmulatorSensorRestoreEntry = this.entries.get(device.deviceId) ?? {
      device,
      originals: new Map(),
    };
    this.entries.set(device.deviceId, entry);
    entry.device = device;
    if (owner !== undefined) {
      entry.owner = owner;
    }
    if (entry.originals.has(sensor)) {
      return false;
    }
    entry.originals.set(sensor, [...value]);
    return true;
  }

  /** Drop one sensor's slot: it was restored, or the write that recorded it never landed. */
  forget(deviceId: string, sensor: EmulatorSensorName): void {
    const entry = this.entries.get(deviceId);
    entry?.originals.delete(sensor);
    if (entry && entry.originals.size === 0) {
      this.entries.delete(deviceId);
    }
  }

  /** Remove and return the entry `sessionId` owns on `deviceId`, for its release to restore. */
  takeOwnedBy(deviceId: string, sessionId: string): EmulatorSensorRestoreEntry | undefined {
    const entry = this.entries.get(deviceId);
    if (entry?.owner !== sessionId) {
      return undefined;
    }
    this.entries.delete(deviceId);
    return entry;
  }

  /** The device is gone (or its serial now names another emulator): nothing left to restore. */
  retireDevice(deviceId: string): void {
    this.entries.delete(deviceId);
  }
}

export const defaultEmulatorSensorRestoreRegistry = new EmulatorSensorRestoreRegistry();

/**
 * Write every recorded original back, each bounded and outside the releasing
 * request's abort context (cleanup must outlive the call that triggered it).
 * Best effort, like `Shake`'s restore: a failed sensor is logged and the rest
 * still run. Resolves with the sensors that could not be restored.
 */
export async function restoreEmulatorSensors(
  entry: EmulatorSensorRestoreEntry,
  consoleFor: EmulatorSensorConsoleFactory,
  timer: Pick<Timer, "setTimeout" | "clearTimeout">,
): Promise<EmulatorSensorName[]> {
  const sensorConsole = consoleFor(entry.device);
  const failed: EmulatorSensorName[] = [];
  for (const [sensor, value] of entry.originals) {
    try {
      const result = await runWithAbortSignal(undefined, () =>
        raceWithDeadline(
          () =>
            sensorConsole.write(sensor, value, { timeoutMs: EMULATOR_SENSOR_RESTORE_TIMEOUT_MS }),
          {
            timer,
            timeoutMs: EMULATOR_SENSOR_RESTORE_TIMEOUT_MS,
            label: `Restore emulator ${sensor} sensor`,
          },
        ),
      );
      if (!result.ok) {
        throw new Error(result.reason);
      }
    } catch (error) {
      failed.push(sensor);
      logger.warn(
        `Failed to restore ${sensor} to ${formatEmulatorSensorValue(value)} on ${entry.device.deviceId}: ${errorMessage(error)}`,
        error,
      );
    }
  }
  return failed;
}
