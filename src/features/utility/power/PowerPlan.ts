import {
  POWER_DOZE_REQUIRES_UNPLUGGED,
  POWER_PHYSICAL_DEVICE_REFUSED,
  POWER_UNSUPPORTED_API,
  type PowerErrorCode,
  type SetPowerInput,
} from "./PowerTypes";

/** First API level that has each control (`am set-standby-bucket`, thermalservice, ...). */
export const POWER_MIN_API = {
  batterySaver: 21,
  doze: 23,
  appInactive: 23,
  dataSaver: 24,
  standbyBucket: 28,
  thermal: 29,
  restrictedBucket: 30,
} as const;

export interface PowerTarget {
  isEmulator: boolean;
  /** `ro.build.version.sdk`; null when it could not be read (API gates are then not applied). */
  sdk: number | null;
}

export interface PowerRefusal {
  code: PowerErrorCode;
  message: string;
}

const PHYSICAL_HINT =
  "AutoMobile only fakes battery, Doze and thermal state on emulators: on a physical device a fake " +
  "survives the session unless released cleanly and can strand the phone unplugged or throttled. " +
  "Undoing a fake (battery.reset, doze off, thermalStatus reset) is allowed.";

function physicalRefusal(input: SetPowerInput, target: PowerTarget): PowerRefusal | undefined {
  if (target.isEmulator) {
    return undefined;
  }
  const faked = [
    input.battery && !input.battery.reset ? "battery" : undefined,
    input.doze === "light" || input.doze === "deep" ? "doze" : undefined,
    typeof input.thermalStatus === "number" ? "thermalStatus" : undefined,
  ].filter((field): field is string => field !== undefined);
  return faked.length === 0
    ? undefined
    : {
        code: POWER_PHYSICAL_DEVICE_REFUSED,
        message: `${POWER_PHYSICAL_DEVICE_REFUSED}: power.${faked.join(", power.")} is refused on a physical device. ${PHYSICAL_HINT}`,
      };
}

function dozeConflict(input: SetPowerInput): PowerRefusal | undefined {
  const forced = input.doze === "light" || input.doze === "deep";
  const plugged = input.battery?.charging !== undefined && input.battery.charging !== "none";
  return forced && (plugged || input.battery?.reset)
    ? {
        code: POWER_DOZE_REQUIRES_UNPLUGGED,
        message:
          `${POWER_DOZE_REQUIRES_UNPLUGGED}: Doze only starts on an unplugged device, but power.battery ` +
          `asks for ${input.battery?.reset ? "a reset (real charger state)" : `charging ${input.battery?.charging}`}. ` +
          'Drop it or use charging "none".',
      }
    : undefined;
}

function apiGates(input: SetPowerInput): Array<[number, string, boolean]> {
  return [
    [POWER_MIN_API.batterySaver, "batterySaver", input.batterySaver !== undefined],
    [POWER_MIN_API.doze, "doze", input.doze !== undefined],
    [POWER_MIN_API.appInactive, "appInactive", input.appInactive !== undefined],
    [POWER_MIN_API.dataSaver, "dataSaver", input.dataSaver !== undefined],
    [POWER_MIN_API.standbyBucket, "standbyBucket", input.standbyBucket !== undefined],
    [
      POWER_MIN_API.restrictedBucket,
      "standbyBucket.bucket restricted",
      input.standbyBucket?.bucket === "restricted",
    ],
    [POWER_MIN_API.thermal, "thermalStatus", input.thermalStatus !== undefined],
  ];
}

function apiRefusal(input: SetPowerInput, target: PowerTarget): PowerRefusal | undefined {
  const sdk = target.sdk;
  const unmet =
    sdk === null ? undefined : apiGates(input).find(([min, , used]) => used && sdk < min);
  return unmet
    ? {
        code: POWER_UNSUPPORTED_API,
        message: `${POWER_UNSUPPORTED_API}: power.${unmet[1]} needs API ${unmet[0]}+, but the device is API ${sdk}.`,
      }
    : undefined;
}

/** Why `input` cannot be applied to `target`, decided before anything is changed. */
export function powerRefusal(input: SetPowerInput, target: PowerTarget): PowerRefusal | undefined {
  return physicalRefusal(input, target) ?? dozeConflict(input) ?? apiRefusal(input, target);
}
