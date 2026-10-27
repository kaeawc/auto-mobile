/**
 * The Android emulator's virtual sensors, driven through the emulator console
 * (`adb -s <serial> emu sensor get|set <name> [a[:b[:c]]]`), the same path
 * `Shake` uses for acceleration (#10250) and `setPosture` for the hinge angle (#14114).
 *
 * The console answers `<name> = a:b:c` (each value printed with `%g`) then `OK`
 * on success, and `KO: <reason>` on refusal, with a zero adb exit code either way.
 */
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { consolePortFromSerial } from "../../utils/android-cmdline-tools/EmulatorConsoleClient";
import {
  emulatorConsoleFailureReason,
  emulatorConsoleReportsFailure,
} from "../../utils/android-cmdline-tools/emulatorConsoleReply";
import type { BootedDevice } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";

/** The console sensor names `setSensor` drives, in the emulator's own order. */
export const EMULATOR_SENSOR_NAMES = [
  "acceleration",
  "gyroscope",
  "magnetic-field",
  "orientation",
  "temperature",
  "proximity",
  "light",
  "pressure",
  "humidity",
] as const;

export type EmulatorSensorName = (typeof EMULATOR_SENSOR_NAMES)[number];

interface SensorComponentSpec {
  label: string;
  min: number;
  max: number;
}

interface EmulatorSensorSpec {
  unit: string;
  components: readonly SensorComponentSpec[];
}

function axes(min: number, max: number): readonly SensorComponentSpec[] {
  return ["x", "y", "z"].map((label) => ({ label, min, max }));
}

/**
 * Arity and conservative sanity bounds per sensor. The console accepts any float;
 * these bounds reject values no real sensor reports, so a typo cannot reach an app.
 */
export const EMULATOR_SENSOR_SPECS: Readonly<Record<EmulatorSensorName, EmulatorSensorSpec>> = {
  // The same bound `shake` uses for its acceleration intensity.
  acceleration: { unit: "m/s²", components: axes(-1000, 1000) },
  gyroscope: { unit: "rad/s", components: axes(-100, 100) },
  "magnetic-field": { unit: "µT", components: axes(-2000, 2000) },
  orientation: {
    unit: "degrees",
    components: [
      { label: "azimuth", min: 0, max: 360 },
      { label: "pitch", min: -180, max: 180 },
      { label: "roll", min: -90, max: 90 },
    ],
  },
  temperature: { unit: "°C", components: [{ label: "ambient", min: -273.15, max: 1000 }] },
  proximity: { unit: "cm", components: [{ label: "distance", min: 0, max: 100 }] },
  light: { unit: "lux", components: [{ label: "illuminance", min: 0, max: 200_000 }] },
  pressure: { unit: "hPa", components: [{ label: "pressure", min: 0, max: 2000 }] },
  humidity: { unit: "%", components: [{ label: "relative", min: 0, max: 100 }] },
};

/** Why `value` is not a valid reading for `sensor`, or undefined when it is. */
export function emulatorSensorValueError(
  sensor: EmulatorSensorName,
  value: readonly number[],
): string | undefined {
  const { unit, components } = EMULATOR_SENSOR_SPECS[sensor];
  if (value.length !== components.length) {
    const labels = components.map((component) => component.label).join(", ");
    return `${sensor} takes ${components.length} value${components.length === 1 ? "" : "s"} (${labels}), got ${value.length}.`;
  }
  const outOfRange = components.findIndex(
    (component, index) =>
      !Number.isFinite(value[index]) ||
      value[index] < component.min ||
      value[index] > component.max,
  );
  if (outOfRange === -1) {
    return undefined;
  }
  const { label, min, max } = components[outOfRange];
  return `${sensor} ${label} must be a finite number from ${min} to ${max} ${unit}, got ${value[outOfRange]}.`;
}

/**
 * The console's `a:b:c` form. Values are rounded to 6 decimal places so no
 * exponent notation (e.g. `1e-7`) reaches the console's float parser.
 */
export function formatEmulatorSensorValue(value: readonly number[]): string {
  return value.map((component) => String(Number(component.toFixed(6)) || 0)).join(":");
}

/** Round as {@link formatEmulatorSensorValue} does, so results echo what the console received. */
export function roundEmulatorSensorValue(value: readonly number[]): number[] {
  return value.map((component) => Number(component.toFixed(6)) || 0);
}

/**
 * Parse `sensor get` output: exactly one `<name> = a[:b[:c]]` line of finite
 * numbers with the sensor's arity. Other lines (the `OK` trailer, adb noise) are
 * ignored; anything ambiguous returns undefined rather than a guessed value.
 */
export function parseEmulatorSensorReadback(
  stdout: string,
  sensor: EmulatorSensorName,
): number[] | undefined {
  const prefix = `${sensor} =`;
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) {
    return undefined;
  }
  const components = lines[0]
    .slice(prefix.length)
    .split(":")
    .map((component) => component.trim());
  if (
    components.length !== EMULATOR_SENSOR_SPECS[sensor].components.length ||
    components.some((component) => component.length === 0 || !Number.isFinite(Number(component)))
  ) {
    return undefined;
  }
  // `Number("-0")` is -0; report it as 0 so results serialize the way the console reads.
  return components.map((component) => Number(component) || 0);
}

/** Whether the device has an emulator console: only `emulator-<port>` serials do. */
export function hasEmulatorSensorConsole(device: BootedDevice): boolean {
  return device.platform === "android" && consolePortFromSerial(device.deviceId) !== null;
}

export const EMULATOR_SENSOR_UNSUPPORTED_MESSAGE =
  "Emulator sensors are only available on an Android emulator: they are driven through the " +
  "emulator console (`adb emu sensor`), which physical Android devices and iOS do not have. " +
  "Target an Android emulator (serial emulator-<port>) instead.";

export type EmulatorSensorRead = { ok: true; value: number[] } | { ok: false; reason: string };
export type EmulatorSensorWrite = { ok: true } | { ok: false; reason: string };

export interface EmulatorSensorCommandOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The two console verbs `setSensor` and `getDeviceState` need; faked in unit tests. */
export interface EmulatorSensorConsole {
  /** Rejects only when adb itself fails; a console refusal resolves `ok: false`. */
  read(
    sensor: EmulatorSensorName,
    options?: EmulatorSensorCommandOptions,
  ): Promise<EmulatorSensorRead>;
  /** Rejects only when adb itself fails; a console refusal resolves `ok: false`. */
  write(
    sensor: EmulatorSensorName,
    value: readonly number[],
    options?: EmulatorSensorCommandOptions,
  ): Promise<EmulatorSensorWrite>;
}

export class AdbEmulatorSensorConsole implements EmulatorSensorConsole {
  constructor(private readonly adb: Pick<AdbExecutor, "executeCommand">) {}

  async read(
    sensor: EmulatorSensorName,
    options: EmulatorSensorCommandOptions = {},
  ): Promise<EmulatorSensorRead> {
    const { stdout, stderr } = await this.adb.executeCommand(`emu sensor get ${sensor}`, {
      noRetry: true,
      ...options,
    });
    if (emulatorConsoleReportsFailure(stdout, stderr)) {
      return { ok: false, reason: emulatorConsoleFailureReason(stdout, stderr) };
    }
    const value = parseEmulatorSensorReadback(stdout, sensor);
    return value
      ? { ok: true, value }
      : { ok: false, reason: `unrecognized ${sensor} read-back: ${stdout.trim() || "(empty)"}` };
  }

  async write(
    sensor: EmulatorSensorName,
    value: readonly number[],
    options: EmulatorSensorCommandOptions = {},
  ): Promise<EmulatorSensorWrite> {
    const { stdout, stderr } = await this.adb.executeCommand(
      `emu sensor set ${sensor} ${formatEmulatorSensorValue(value)}`,
      { noRetry: true, ...options },
    );
    return emulatorConsoleReportsFailure(stdout, stderr)
      ? { ok: false, reason: emulatorConsoleFailureReason(stdout, stderr) }
      : { ok: true };
  }
}

/** `getDeviceState` `sensors`: each sensor's current value, or why it could not be read. */
export interface DeviceSensorsState {
  supported: boolean;
  method?: "android_emulator_console";
  sensors?: Array<{ name: EmulatorSensorName; value: number[] }>;
  /** Sensors the console refused or answered unrecognizably, e.g. disabled in the AVD. */
  unavailable?: Array<{ name: EmulatorSensorName; reason: string }>;
  error?: string;
}

/**
 * Read every {@link EMULATOR_SENSOR_NAMES} sensor with `sensor get`. A console
 * refusal marks one sensor unavailable; an adb failure ends the read with an error.
 */
export async function readEmulatorSensors(
  device: BootedDevice,
  consoleFor: () => EmulatorSensorConsole,
): Promise<DeviceSensorsState> {
  if (!hasEmulatorSensorConsole(device)) {
    return { supported: false, error: EMULATOR_SENSOR_UNSUPPORTED_MESSAGE };
  }
  const sensorConsole = consoleFor();
  const sensors: NonNullable<DeviceSensorsState["sensors"]> = [];
  const unavailable: NonNullable<DeviceSensorsState["unavailable"]> = [];
  try {
    for (const name of EMULATOR_SENSOR_NAMES) {
      const read = await sensorConsole.read(name);
      if (read.ok) {
        sensors.push({ name, value: read.value });
      } else {
        unavailable.push({ name, reason: read.reason });
      }
    }
  } catch (error) {
    logger.warn(
      `Failed to read emulator sensors on ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return {
      supported: true,
      method: "android_emulator_console",
      error: `Failed to read emulator sensors: ${errorMessage(error)}`,
    };
  }
  return {
    supported: true,
    method: "android_emulator_console",
    sensors,
    ...(unavailable.length > 0 ? { unavailable } : {}),
  };
}
