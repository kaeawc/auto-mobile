import { record, type Raw } from "./prototypeTemplate";
import type { PrototypePlatformError } from "./prototypePlatform";

/** The sensor behind each `/platform/sensors` key and event (#14327). */
const SENSOR_OF: Readonly<Record<string, string>> = {
  pitchDeg: "orientation",
  rollDeg: "orientation",
  headingDeg: "orientation",
  steps: "steps",
  proximityNear: "proximity",
  lightLux: "light",
  shake: "shake",
};

/**
 * Root `sensors` block rules (#14327) the contract cannot express: the block needs `sensors` in
 * `requires.platform`, and `steps` needs the `motion` permission in `requires.permissions`. Kotlin
 * `PrototypeSensorRules` and Swift `PrototypeSensorRules` mirror these checks.
 */
export function prototypeSensorsBlockError(root: Raw): PrototypePlatformError | undefined {
  const sensors = record(root.sensors);
  if (!sensors) {
    return undefined;
  }
  const requires = record(root.requires);
  if (!Array.isArray(requires?.platform) || !requires.platform.includes("sensors")) {
    return { path: "sensors", message: "The sensors block requires sensors in requires.platform" };
  }
  const permissions = Array.isArray(requires.permissions) ? requires.permissions : [];
  if (
    sensors.steps !== undefined &&
    !permissions.some((entry) => record(entry)?.name === "motion")
  ) {
    return {
      path: "sensors.steps",
      message: "steps requires permission motion in requires.permissions",
    };
  }
  return undefined;
}

/**
 * A `/platform/sensors/<key>` read or `sensors.<event>` handler whose sensor the root `sensors`
 * block does not list: the device listens only to declared sensors. `member` is the key or event
 * name; one with no sensor is left to the contract's own checks.
 */
export function prototypeSensorUseError(
  member: string,
  path: string,
  root: Raw,
): PrototypePlatformError | undefined {
  const sensor = Object.hasOwn(SENSOR_OF, member) ? SENSOR_OF[member] : undefined;
  return sensor && record(root.sensors)?.[sensor] === undefined
    ? { path, message: `Sensor ${sensor} is not declared in the sensors block` }
    : undefined;
}
