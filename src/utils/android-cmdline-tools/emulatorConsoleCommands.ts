import { ActionableError } from "../../models/ActionableError";

/**
 * Pure builders for emulator-console command lines (#14057). Each builder
 * validates its arguments and returns the exact wire string, so a bad value is
 * rejected before a console connection is opened and nothing a caller passes
 * can smuggle a second command onto the line.
 *
 * Reference: https://developer.android.com/studio/run/emulator-console
 */

/** `power status` values accepted by the console. */
export const CONSOLE_POWER_STATUSES = [
  "unknown",
  "charging",
  "discharging",
  "not-charging",
  "full",
] as const;
export type ConsolePowerStatus = (typeof CONSOLE_POWER_STATUSES)[number];

/** `power health` values accepted by the console. */
export const CONSOLE_POWER_HEALTHS = [
  "unknown",
  "good",
  "overheat",
  "dead",
  "overvoltage",
  "failure",
] as const;
export type ConsolePowerHealth = (typeof CONSOLE_POWER_HEALTHS)[number];

/** `gsm data` / `gsm voice` registration states accepted by the console. */
export const CONSOLE_RADIO_STATES = [
  "unregistered",
  "home",
  "roaming",
  "searching",
  "denied",
] as const;
export type ConsoleRadioState = (typeof CONSOLE_RADIO_STATES)[number];

/** `network speed` presets accepted by the console. */
export const CONSOLE_NETWORK_SPEED_PRESETS = [
  "gsm",
  "hscsd",
  "gprs",
  "edge",
  "umts",
  "hsdpa",
  "lte",
  "evdo",
  "full",
] as const;
export type ConsoleNetworkSpeedPreset = (typeof CONSOLE_NETWORK_SPEED_PRESETS)[number];

/** `network delay` presets accepted by the console. */
export const CONSOLE_NETWORK_DELAY_PRESETS = ["gprs", "edge", "umts", "none"] as const;
export type ConsoleNetworkDelayPreset = (typeof CONSOLE_NETWORK_DELAY_PRESETS)[number];

/** Explicit uplink/downlink rates in kilobits per second. */
export interface ConsoleNetworkSpeedRates {
  upKbps: number;
  downKbps: number;
}

/** Explicit latency in milliseconds; `maxMs` makes it a random range. */
export interface ConsoleNetworkDelayRange {
  minMs: number;
  maxMs?: number;
}

export type ConsoleNetworkSpeed = ConsoleNetworkSpeedPreset | ConsoleNetworkSpeedRates;
export type ConsoleNetworkDelay = ConsoleNetworkDelayPreset | ConsoleNetworkDelayRange;

/** Posture verbs; `rotate` turns the screen 90 degrees counter-clockwise. */
export type ConsolePostureVerb = "rotate" | "fold" | "unfold";

/** Highest RSSI the console accepts; `99` means "unknown". */
const GSM_SIGNAL_RSSI_MAX = 31;
/** Highest bit-error-rate class the console accepts; `99` means "unknown". */
const GSM_SIGNAL_BER_MAX = 7;
const GSM_SIGNAL_UNKNOWN = 99;
/** Sensor names are lowercase words joined by hyphens, e.g. `magnetic-field`. */
const SENSOR_NAME = /^[a-z][a-z0-9-]*$/;
/** The console takes at most three components (`x:y:z`). */
const SENSOR_MAX_COMPONENTS = 3;

function requireOneOf<T extends string>(label: string, value: string, allowed: readonly T[]): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new ActionableError(
      `Invalid ${label} '${value}'. Expected one of: ${allowed.join(", ")}.`,
    );
  }
  return match;
}

function requireInteger(label: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ActionableError(`${label} must be an integer in [${min}, ${max}] (got ${value}).`);
  }
  return value;
}

function requireNonNegativeFinite(label: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ActionableError(`${label} must be a finite, non-negative number (got ${value}).`);
  }
  return value;
}

export function buildPowerAcCommand(online: boolean): string {
  return `power ac ${online ? "on" : "off"}`;
}

export function buildPowerStatusCommand(status: ConsolePowerStatus): string {
  return `power status ${requireOneOf("power status", status, CONSOLE_POWER_STATUSES)}`;
}

export function buildPowerHealthCommand(health: ConsolePowerHealth): string {
  return `power health ${requireOneOf("power health", health, CONSOLE_POWER_HEALTHS)}`;
}

export function buildPowerCapacityCommand(percent: number): string {
  return `power capacity ${requireInteger("Battery capacity", percent, 0, 100)}`;
}

function validateSensorName(name: string): string {
  if (!SENSOR_NAME.test(name)) {
    throw new ActionableError(
      `Invalid sensor name '${name}'. Expected a console sensor name such as 'acceleration' or 'magnetic-field'.`,
    );
  }
  return name;
}

export function buildSensorSetCommand(name: string, values: readonly number[]): string {
  const sensor = validateSensorName(name);
  if (values.length === 0 || values.length > SENSOR_MAX_COMPONENTS) {
    throw new ActionableError(
      `sensor set requires 1 to ${SENSOR_MAX_COMPONENTS} values (got ${values.length}).`,
    );
  }
  if (!values.every((value) => Number.isFinite(value))) {
    throw new ActionableError("sensor set values must be finite numbers.");
  }
  return `sensor set ${sensor} ${values.join(":")}`;
}

export function buildSensorGetCommand(name: string): string {
  return `sensor get ${validateSensorName(name)}`;
}

/**
 * Extracts the component values from `sensor get` output, which prints a data
 * line such as `acceleration = 0:9.81:0` before the `OK` acknowledgement.
 */
export function parseSensorGetOutput(name: string, output: string): number[] {
  const prefix = `${name} =`;
  const line = output
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(prefix));
  const values = line
    ?.slice(prefix.length)
    .trim()
    .split(":")
    // `Number("")` is 0, so an empty component must be rejected explicitly.
    .map((component) => (component.trim() === "" ? Number.NaN : Number(component)));
  if (!values || values.length === 0 || !values.every((value) => Number.isFinite(value))) {
    throw new ActionableError(`Emulator console did not report a value for sensor '${name}'.`);
  }
  return values;
}

export function buildNetworkSpeedCommand(speed: ConsoleNetworkSpeed): string {
  if (typeof speed === "string") {
    return `network speed ${requireOneOf("network speed", speed, CONSOLE_NETWORK_SPEED_PRESETS)}`;
  }
  const up = requireNonNegativeFinite("network speed upKbps", speed.upKbps);
  const down = requireNonNegativeFinite("network speed downKbps", speed.downKbps);
  return `network speed ${up}:${down}`;
}

export function buildNetworkDelayCommand(delay: ConsoleNetworkDelay): string {
  if (typeof delay === "string") {
    return `network delay ${requireOneOf("network delay", delay, CONSOLE_NETWORK_DELAY_PRESETS)}`;
  }
  const min = requireNonNegativeFinite("network delay minMs", delay.minMs);
  if (delay.maxMs === undefined) {
    return `network delay ${min}`;
  }
  const max = requireNonNegativeFinite("network delay maxMs", delay.maxMs);
  if (max < min) {
    throw new ActionableError(`network delay maxMs (${max}) must not be less than minMs (${min}).`);
  }
  return `network delay ${min}:${max}`;
}

export function buildGsmRadioCommand(radio: "data" | "voice", state: ConsoleRadioState): string {
  return `gsm ${radio} ${requireOneOf(`gsm ${radio} state`, state, CONSOLE_RADIO_STATES)}`;
}

function validateSignalComponent(label: string, value: number, max: number): number {
  if (value === GSM_SIGNAL_UNKNOWN) {
    return value;
  }
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new ActionableError(
      `${label} must be an integer in [0, ${max}] or ${GSM_SIGNAL_UNKNOWN} for unknown (got ${value}).`,
    );
  }
  return value;
}

export function buildGsmSignalCommand(rssi: number, ber?: number): string {
  const safeRssi = validateSignalComponent("gsm signal rssi", rssi, GSM_SIGNAL_RSSI_MAX);
  if (ber === undefined) {
    return `gsm signal ${safeRssi}`;
  }
  const safeBer = validateSignalComponent("gsm signal ber", ber, GSM_SIGNAL_BER_MAX);
  return `gsm signal ${safeRssi} ${safeBer}`;
}

export function buildFingerTouchCommand(fingerprintId: number): string {
  return `finger touch ${requireInteger("Fingerprint id", fingerprintId, 1, 2_147_483_647)}`;
}

export function buildFingerRemoveCommand(): string {
  return "finger remove";
}

export function buildPostureCommand(verb: ConsolePostureVerb): string {
  return requireOneOf("posture command", verb, ["rotate", "fold", "unfold"] as const);
}
