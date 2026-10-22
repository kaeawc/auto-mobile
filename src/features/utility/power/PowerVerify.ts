import type { PowerState, SetPowerInput } from "./PowerTypes";

const CHARGING_SAVER_HINT =
  " (Android turns battery saver off while a charger is connected; set power.battery.charging to none)";

type Check = (input: SetPowerInput, after: PowerState) => string | undefined;

const mismatch = (field: string, wanted: unknown, got: unknown, extra = ""): string =>
  `${field}: wanted ${String(wanted)}, device reports ${String(got)}${extra}`;

const batteryReset: Check = (input, after) =>
  input.battery?.reset && after.battery?.faked !== false
    ? "battery.reset: the battery still reports a fake"
    : undefined;

const batteryLevel: Check = (input, after) =>
  input.battery?.level !== undefined && after.battery?.level !== input.battery.level
    ? mismatch("battery.level", input.battery.level, after.battery?.level)
    : undefined;

const batteryCharging: Check = (input, after) =>
  input.battery?.charging && after.battery?.charging !== input.battery.charging
    ? mismatch("battery.charging", input.battery.charging, after.battery?.charging)
    : undefined;

const doze: Check = (input, after) =>
  input.doze && after.doze?.mode !== input.doze
    ? mismatch(
        "doze",
        input.doze,
        after.doze?.mode,
        ` (deep ${after.doze?.deep}, light ${after.doze?.light})`,
      )
    : undefined;

const batterySaver: Check = (input, after) => {
  if (input.batterySaver === undefined || (after.batterySaver ?? false) === input.batterySaver) {
    return undefined;
  }
  const hint = input.batterySaver && after.battery?.charging !== "none" ? CHARGING_SAVER_HINT : "";
  return mismatch("batterySaver", input.batterySaver, after.batterySaver, hint);
};

const dataSaver: Check = (input, after) =>
  input.dataSaver !== undefined && after.dataSaver !== input.dataSaver
    ? mismatch("dataSaver", input.dataSaver, after.dataSaver)
    : undefined;

const thermalReset: Check = (input, after) =>
  input.thermalStatus === "reset" && after.thermal?.override !== false
    ? "thermalStatus: the status is still overridden"
    : undefined;

const thermalOverride: Check = (input, after) =>
  typeof input.thermalStatus === "number" &&
  (after.thermal?.status !== input.thermalStatus || !after.thermal.override)
    ? mismatch("thermalStatus", input.thermalStatus, after.thermal?.status)
    : undefined;

const standbyBucket: Check = (input, after) => {
  const wanted = input.standbyBucket;
  const got = after.standby?.find((app) => app.appId === wanted?.appId)?.bucket;
  return wanted && got !== wanted.bucket
    ? mismatch(`standbyBucket for ${wanted.appId}`, wanted.bucket, got)
    : undefined;
};

const appInactive: Check = (input, after) => {
  const wanted = input.appInactive;
  const got = after.standby?.find((app) => app.appId === wanted?.appId)?.inactive;
  return wanted && got !== wanted.inactive
    ? mismatch(`appInactive for ${wanted.appId}`, wanted.inactive, got)
    : undefined;
};

const CHECKS: readonly Check[] = [
  batteryReset,
  batteryLevel,
  batteryCharging,
  doze,
  batterySaver,
  dataSaver,
  thermalReset,
  thermalOverride,
  standbyBucket,
  appInactive,
];

/** Requested values a fresh read does not show. */
export function verifyRequested(input: SetPowerInput, after: PowerState): string[] {
  return CHECKS.map((check) => check(input, after)).filter(
    (message): message is string => message !== undefined,
  );
}
