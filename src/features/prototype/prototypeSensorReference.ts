/**
 * The reference the Android and iOS runtimes copy for the `sensors` module (#14327): how raw sensor
 * samples become `/platform/sensors/*` writes and `sensors.shake` events. Pure functions over
 * timestamped samples, so the shared JSON sample streams under `test/fixtures/prototype-sensors/`
 * replay identically in every runtime.
 *
 * - Continuous readings are rounded (whole degrees, whole lux, a heading in 0..359), and a key is
 *   written only when its rounded value changes and at least `1000 / rateHz` ms passed since the
 *   key's last write. `rateHz` is limited to 1..30, so no platform needs a high-sampling permission.
 * - A shake is an acceleration magnitude at or above `thresholdG` (in g); after one, further peaks
 *   are ignored for `cooldownMs`.
 */

export const PROTOTYPE_SENSOR_MIN_RATE_HZ = 1;
export const PROTOTYPE_SENSOR_MAX_RATE_HZ = 30;
/** Standard gravity in m/s²: accelerometer samples are in m/s², shake thresholds in g. */
export const STANDARD_GRAVITY = 9.80665;
export const PROTOTYPE_SHAKE_THRESHOLD_G = 2.7;
export const PROTOTYPE_SHAKE_COOLDOWN_MS = 1000;

export type PrototypeSensorKey = "pitchDeg" | "rollDeg" | "headingDeg" | "lightLux" | "steps";

export interface PrototypeSensorSample {
  timestampMs: number;
  value: number;
}

export interface PrototypeAccelerationSample {
  timestampMs: number;
  x: number;
  y: number;
  z: number;
}

/** Whether a declared `rateHz` is a whole number the runtimes can honour without extra permission. */
export function prototypeSensorRateValid(rateHz: number): boolean {
  return (
    Number.isInteger(rateHz) &&
    rateHz >= PROTOTYPE_SENSOR_MIN_RATE_HZ &&
    rateHz <= PROTOTYPE_SENSOR_MAX_RATE_HZ
  );
}

/** The value a key stores: whole units, a heading folded into 0..359, pitch and roll in -180..180. */
export function roundPrototypeSensorValue(key: PrototypeSensorKey, value: number): number {
  const whole = Math.round(value);
  switch (key) {
    case "headingDeg":
      return ((whole % 360) + 360) % 360;
    case "pitchDeg":
    case "rollDeg":
      return Math.max(-180, Math.min(180, whole));
    default:
      return Math.max(0, whole);
  }
}

/**
 * The writes one key receives from a sample stream: the first finite sample, then each later sample
 * whose rounded value differs from the last write and arrives at least the throttle interval after
 * it. Samples must be in timestamp order; non-finite values are skipped.
 */
export function throttlePrototypeSensorSamples(
  key: PrototypeSensorKey,
  samples: readonly PrototypeSensorSample[],
  rateHz: number,
): PrototypeSensorSample[] {
  if (!prototypeSensorRateValid(rateHz)) {
    throw new RangeError(`rateHz must be a whole number from 1 to 30, got ${rateHz}`);
  }
  const intervalMs = 1000 / rateHz;
  const writes: PrototypeSensorSample[] = [];
  for (const sample of samples) {
    if (!Number.isFinite(sample.value)) {
      continue;
    }
    const value = roundPrototypeSensorValue(key, sample.value);
    const last = writes.at(-1);
    if (
      last === undefined ||
      (value !== last.value && sample.timestampMs - last.timestampMs >= intervalMs)
    ) {
      writes.push({ timestampMs: sample.timestampMs, value });
    }
  }
  return writes;
}

/** The timestamps of `sensors.shake` events in an accelerometer stream (m/s², timestamp order). */
export function detectPrototypeShakes(
  samples: readonly PrototypeAccelerationSample[],
  thresholdG = PROTOTYPE_SHAKE_THRESHOLD_G,
  cooldownMs = PROTOTYPE_SHAKE_COOLDOWN_MS,
): number[] {
  const shakes: number[] = [];
  for (const sample of samples) {
    const g = Math.hypot(sample.x, sample.y, sample.z) / STANDARD_GRAVITY;
    const last = shakes.at(-1);
    if (g >= thresholdG && (last === undefined || sample.timestampMs - last >= cooldownMs)) {
      shakes.push(sample.timestampMs);
    }
  }
  return shakes;
}
