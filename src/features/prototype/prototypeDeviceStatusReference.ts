import { PROTOTYPE_PLATFORM_MODULES } from "./prototypePlatform";

/**
 * The reference the Android and iOS runtimes copy for the `battery`, `power` and `audio` modules
 * (#14316): how raw platform readings become `/platform/<module>/*` values, and when a
 * `<module>.changed` event is delivered. Pure functions, so the shared fixtures under
 * `test/fixtures/prototype-device-status/` replay identically in every runtime.
 *
 * A reading the platform cannot give (an unknown battery level, an out-of-range status) maps to
 * `undefined`, and the runtime leaves that key absent, so it compares as missing.
 */

export type PrototypeThermalState = "nominal" | "fair" | "serious" | "critical";
export type PrototypeBatteryState = "charging" | "full" | "unplugged" | "unknown";
export type PrototypeRingerMode = "normal" | "vibrate" | "silent";
export type PrototypeStatusModule = "battery" | "power" | "audio";

/**
 * Android `PowerManager.THERMAL_STATUS_*` (0..6): NONE is nominal, LIGHT and MODERATE are fair,
 * SEVERE is serious, and CRITICAL, EMERGENCY and SHUTDOWN are critical.
 */
export function prototypeAndroidThermalState(status: number): PrototypeThermalState | undefined {
  return (["nominal", "fair", "fair", "serious", "critical", "critical", "critical"] as const)[
    wholeIndex(status, 6)
  ];
}

/** iOS `ProcessInfo.ThermalState` raw values (0..3) map one to one. */
export function prototypeIosThermalState(rawValue: number): PrototypeThermalState | undefined {
  return (["nominal", "fair", "serious", "critical"] as const)[wholeIndex(rawValue, 3)];
}

const ANDROID_BATTERY_STATES: ReadonlyMap<number, PrototypeBatteryState> = new Map([
  [2, "charging"],
  [3, "unplugged"],
  [4, "unplugged"],
  [5, "full"],
]);

/**
 * Android `BatteryManager.BATTERY_STATUS_*`: CHARGING (2) is charging, FULL (5) is full,
 * DISCHARGING (3) and NOT_CHARGING (4) are unplugged, and UNKNOWN (1) or any other value is unknown.
 */
export function prototypeAndroidBatteryState(status: number): PrototypeBatteryState {
  return ANDROID_BATTERY_STATES.get(status) ?? "unknown";
}

/** iOS `UIDevice.BatteryState` raw values: unknown (0), unplugged (1), charging (2), full (3). */
export function prototypeIosBatteryState(rawValue: number): PrototypeBatteryState {
  return (
    (["unknown", "unplugged", "charging", "full"] as const)[wholeIndex(rawValue, 3)] ?? "unknown"
  );
}

/** Android `EXTRA_LEVEL` out of `EXTRA_SCALE`, as a whole percent; absent when either is invalid. */
export function prototypeAndroidBatteryLevel(level: number, scale: number): number | undefined {
  return Number.isFinite(level) && Number.isFinite(scale) && scale > 0 && level >= 0
    ? percent(level / scale)
    : undefined;
}

/** iOS `UIDevice.batteryLevel` (0..1, or -1 when unknown, as on the Simulator) as a whole percent. */
export function prototypeIosBatteryLevel(level: number): number | undefined {
  return Number.isFinite(level) && level >= 0 ? percent(level) : undefined;
}

/** Android media-stream volume: the stream index out of its maximum, as a whole percent. */
export function prototypeAndroidVolume(index: number, max: number): number | undefined {
  return Number.isFinite(index) && Number.isFinite(max) && max > 0 && index >= 0
    ? percent(index / max)
    : undefined;
}

/** iOS `AVAudioSession.outputVolume` (0..1) as a whole percent. */
export function prototypeIosVolume(outputVolume: number): number | undefined {
  return Number.isFinite(outputVolume) && outputVolume >= 0 ? percent(outputVolume) : undefined;
}

/** Android `AudioManager.RINGER_MODE_*`: SILENT (0), VIBRATE (1), NORMAL (2). iOS has no ringer. */
export function prototypeAndroidRingerMode(mode: number): PrototypeRingerMode | undefined {
  return (["silent", "vibrate", "normal"] as const)[wholeIndex(mode, 2)];
}

/** The contract's delivery debounce for `<module>.changed`. */
export function prototypeStatusDebounceMs(module: PrototypeStatusModule): number {
  const debounceMs = PROTOTYPE_PLATFORM_MODULES[module]?.events.changed?.debounceMs;
  if (debounceMs === undefined) {
    throw new Error(`The contract gives ${module}.changed no debounceMs`);
  }
  return debounceMs;
}

export type PrototypeStatusValues = Readonly<Record<string, string | number | boolean>>;

export interface PrototypeStatusUpdate {
  timestampMs: number;
  values: PrototypeStatusValues;
}

/**
 * The `<module>.changed` deliveries for one module's readings, in timestamp order, as the
 * `connectivity` runtimes deliver theirs (#14273). The first reading is the baseline: it sets the
 * state and is never an event. Each later reading that differs from the current values updates the
 * state at once and restarts a `debounceMs` timer. When the timer fires, the event carries the values
 * current then, unless they equal the last delivered values (a flap that settles back is not an
 * event). A timer due at a reading's timestamp fires before that reading applies.
 */
export function prototypeStatusChangeEvents(
  updates: readonly PrototypeStatusUpdate[],
  debounceMs: number,
): PrototypeStatusUpdate[] {
  const events: PrototypeStatusUpdate[] = [];
  let current: PrototypeStatusValues | undefined;
  let delivered: PrototypeStatusValues | undefined;
  let dueMs: number | undefined;
  const fire = (atMs: number) => {
    if (current && delivered && !sameValues(current, delivered)) {
      events.push({ timestampMs: atMs, values: current });
      delivered = current;
    }
    dueMs = undefined;
  };
  for (const update of updates) {
    if (dueMs !== undefined && update.timestampMs >= dueMs) {
      fire(dueMs);
    }
    if (current === undefined) {
      current = delivered = update.values;
    } else if (!sameValues(current, update.values)) {
      current = update.values;
      dueMs = update.timestampMs + debounceMs;
    }
  }
  if (dueMs !== undefined) {
    fire(dueMs);
  }
  return events;
}

function sameValues(first: PrototypeStatusValues, second: PrototypeStatusValues): boolean {
  const keys = Object.keys(first);
  return (
    keys.length === Object.keys(second).length &&
    keys.every((key) => Object.hasOwn(second, key) && first[key] === second[key])
  );
}

/** A whole number in 0..max, else an index past every table (so the lookup is undefined). */
function wholeIndex(value: number, max: number): number {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : max + 1;
}

function percent(fraction: number): number {
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}
