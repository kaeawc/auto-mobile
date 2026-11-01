import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import {
  EMULATOR_SENSOR_UNSUPPORTED_MESSAGE,
  emulatorSensorValueError,
  formatEmulatorSensorValue,
  hasEmulatorSensorConsole,
  roundEmulatorSensorValue,
  type EmulatorSensorConsole,
  type EmulatorSensorName,
} from "./EmulatorSensors";
import {
  defaultEmulatorSensorRestoreRegistry,
  type EmulatorSensorRestoreRegistry,
} from "./EmulatorSensorRestore";
import { EmulatorSensorUnsupportedError } from "./EmulatorSensorUnsupportedError";

/** Exactly one of `value` or `reset: true` (the tool schema enforces it too). */
export interface SetSensorInput {
  sensor: EmulatorSensorName;
  value?: number[];
  reset?: boolean;
}

/** The restore receipt: what `reset` or session release will write back. */
export interface SensorRestoreReceipt {
  value: number[];
  /** True when a daemon session owns the slot and its release restores the value. */
  onSessionRelease: boolean;
}

export interface SetSensorResult {
  message: string;
  deviceId: string;
  sensor: EmulatorSensorName;
  /** What this call wrote; equals `previous` when a reset had nothing to restore. */
  applied: number[];
  /** The value read from the console immediately before this call. */
  previous: number[];
  /** Whether this call sent a `sensor set` to the console. */
  changed: boolean;
  reset: boolean;
  /** Present while a slot holds the value found before the first change. */
  restore?: SensorRestoreReceipt;
}

export interface SetSensorDependencies {
  console: EmulatorSensorConsole;
  registry?: EmulatorSensorRestoreRegistry;
  /** The daemon session writing, whose release then restores the device's sensors. */
  owner?: string;
  signal?: AbortSignal;
}

function sameValue(a: readonly number[], b: readonly number[]): boolean {
  return formatEmulatorSensorValue(a) === formatEmulatorSensorValue(b);
}

function validateInput(device: BootedDevice, input: SetSensorInput): void {
  if (!hasEmulatorSensorConsole(device)) {
    throw new EmulatorSensorUnsupportedError(
      `setSensor cannot run on ${device.platform} device ${device.deviceId}. ${EMULATOR_SENSOR_UNSUPPORTED_MESSAGE}`,
    );
  }
  if ((input.value === undefined) === (input.reset !== true)) {
    throw new ActionableError("setSensor needs exactly one of value or reset: true.");
  }
  const valueError = input.value && emulatorSensorValueError(input.sensor, input.value);
  if (valueError) {
    throw new ActionableError(valueError);
  }
}

async function readCurrent(
  device: BootedDevice,
  sensor: EmulatorSensorName,
  deps: SetSensorDependencies,
): Promise<number[]> {
  let read;
  try {
    read = await deps.console.read(sensor, { signal: deps.signal });
  } catch (error) {
    throw toActionableError(
      error,
      `Failed to read the ${sensor} sensor on ${device.deviceId}; nothing was changed`,
    );
  }
  if (!read.ok) {
    throw new ActionableError(
      `The emulator console could not read the ${sensor} sensor on ${device.deviceId} (${read.reason}); ` +
        "nothing was changed. Check that the AVD has this sensor enabled (hw.sensors.* in its config.ini).",
    );
  }
  return read.value;
}

/**
 * Set one emulator sensor, or restore it with `reset` (#14114). The value found
 * before the first change is recorded before anything is written, so a release
 * that races the write still restores it. A write the console refuses changes
 * nothing, so the slot it recorded is dropped again.
 */
export async function setEmulatorSensor(
  device: BootedDevice,
  input: SetSensorInput,
  deps: SetSensorDependencies,
): Promise<SetSensorResult> {
  validateInput(device, input);
  const registry = deps.registry ?? defaultEmulatorSensorRestoreRegistry;
  const { sensor } = input;
  const previous = await readCurrent(device, sensor, deps);
  const reset = input.reset === true;
  const target = reset
    ? registry.original(device.deviceId, sensor)
    : roundEmulatorSensorValue(input.value ?? []);
  const base = { deviceId: device.deviceId, sensor, previous, reset };
  if (!target) {
    return {
      ...base,
      message: `No setSensor change to ${sensor} is recorded on ${device.deviceId}; left it at ${formatEmulatorSensorValue(previous)}`,
      applied: previous,
      changed: false,
    };
  }
  const recordedNow = !reset && registry.record(device, sensor, previous, deps.owner);
  await writeTarget(device, sensor, target, {
    deps,
    onRefused: () => {
      if (recordedNow) {
        registry.forget(device.deviceId, sensor);
      }
    },
  });
  const original = registry.original(device.deviceId, sensor);
  // Back at the value found before the first change: release must not later
  // overwrite a change made by hand, so the slot is dropped (as screen reader #10159).
  if (reset || (original && sameValue(original, target))) {
    registry.forget(device.deviceId, sensor);
  }
  const remaining = registry.original(device.deviceId, sensor);
  return {
    ...base,
    message: `${reset ? "Restored" : "Set"} ${sensor} to ${formatEmulatorSensorValue(target)} (was ${formatEmulatorSensorValue(previous)})`,
    applied: target,
    changed: true,
    ...(remaining
      ? {
          restore: {
            value: remaining,
            onSessionRelease: registry.restoresOnRelease(device.deviceId),
          },
        }
      : {}),
  };
}

async function writeTarget(
  device: BootedDevice,
  sensor: EmulatorSensorName,
  target: readonly number[],
  { deps, onRefused }: { deps: SetSensorDependencies; onRefused: () => void },
): Promise<void> {
  const command = `sensor set ${sensor} ${formatEmulatorSensorValue(target)}`;
  let written;
  try {
    written = await deps.console.write(sensor, target, { signal: deps.signal });
  } catch (error) {
    // The write may still have landed, so the recorded original stays for release.
    throw toActionableError(error, `Failed to send '${command}' to ${device.deviceId}`);
  }
  if (!written.ok) {
    onRefused();
    throw new ActionableError(
      `The emulator console refused '${command}' on ${device.deviceId}: ${written.reason}. Nothing was changed.`,
    );
  }
}
