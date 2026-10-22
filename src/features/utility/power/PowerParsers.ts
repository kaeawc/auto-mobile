import type {
  BatteryCharging,
  BatteryReading,
  DozeMode,
  DozeReading,
  ObservedStandbyBucket,
  ThermalReading,
} from "./PowerTypes";

/** Raised when a dumpsys/cmd output has none of the lines a parser needs. */
export class PowerParseError extends Error {}

const BATTERY_STATUS_NAMES: Readonly<Record<string, string>> = {
  "1": "unknown",
  "2": "charging",
  "3": "discharging",
  "4": "not_charging",
  "5": "full",
};

function flag(dump: string, label: string): boolean {
  return new RegExp(`^\\s*${label} powered:\\s*true`, "im").test(dump);
}

/** `dumpsys battery`: level, charger source, status, and whether a fake (`set`/`unplug`) is active. */
export function parseBattery(dump: string): BatteryReading {
  const level = /^\s*level:\s*(\d+)/m.exec(dump)?.[1];
  if (level === undefined) {
    throw new PowerParseError("dumpsys battery output has no level line");
  }
  const charging: BatteryCharging = flag(dump, "AC")
    ? "ac"
    : flag(dump, "USB")
      ? "usb"
      : flag(dump, "Wireless")
        ? "wireless"
        : "none";
  const status = /^\s*status:\s*(\d+)/m.exec(dump)?.[1];
  return {
    level: Number(level),
    charging,
    status: (status && BATTERY_STATUS_NAMES[status]) || "unknown",
    faked: /UPDATES STOPPED/i.test(dump),
  };
}

const IDLE_STATES = new Set(["IDLE", "IDLE_MAINTENANCE"]);

/** `dumpsys deviceidle get deep|light` prints one state name. */
export function parseDozeState(output: string): string {
  const state = output.trim().split(/\s+/)[0] ?? "";
  if (!/^[A-Z_]+$/.test(state)) {
    throw new PowerParseError(`unrecognized deviceidle state: ${output.trim().slice(0, 80)}`);
  }
  return state;
}

export function dozeReading(deep: string, light: string): DozeReading {
  const mode: DozeMode = IDLE_STATES.has(deep) ? "deep" : IDLE_STATES.has(light) ? "light" : "off";
  return { mode, deep, light };
}

/** `dumpsys deviceidle enabled deep|light` prints 1 or 0. */
export function parseDozeEnabled(output: string): boolean {
  const value = output.trim();
  if (value !== "0" && value !== "1") {
    throw new PowerParseError(`unrecognized deviceidle enabled output: ${value.slice(0, 80)}`);
  }
  return value === "1";
}

/** `settings get global <key>` for a 0/1 setting; `null` (the literal) means the key is unset. */
export function parseBooleanSetting(output: string): boolean | undefined {
  const value = output.trim();
  if (value === "" || value === "null") {
    return undefined;
  }
  if (value !== "0" && value !== "1") {
    throw new PowerParseError(`unrecognized boolean setting value: ${value.slice(0, 80)}`);
  }
  return value === "1";
}

/** `cmd netpolicy get restrict-background`. */
export function parseRestrictBackground(output: string): boolean {
  const match = /Restrict background status:\s*(enabled|disabled)/i.exec(output);
  if (!match) {
    throw new PowerParseError("cmd netpolicy output has no restrict background status");
  }
  return match[1]?.toLowerCase() === "enabled";
}

/** `dumpsys thermalservice`: the status the service now reports and whether it is overridden. */
export function parseThermal(dump: string): ThermalReading {
  const status = /Thermal Status:\s*(\d+)/.exec(dump)?.[1];
  if (status === undefined) {
    throw new PowerParseError("dumpsys thermalservice output has no Thermal Status line");
  }
  return { status: Number(status), override: /IsStatusOverride:\s*true/.test(dump) };
}

const BUCKET_BY_VALUE: Readonly<Record<string, ObservedStandbyBucket>> = {
  "5": "exempted",
  "10": "active",
  "20": "working_set",
  "30": "frequent",
  "40": "rare",
  "45": "restricted",
  "50": "never",
  active: "active",
  working_set: "working_set",
  frequent: "frequent",
  rare: "rare",
  restricted: "restricted",
  exempted: "exempted",
  never: "never",
};

/** `am get-standby-bucket <pkg>`: the numeric bucket, or its name on builds that print it. */
export function parseStandbyBucket(output: string): ObservedStandbyBucket {
  const token = output.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return BUCKET_BY_VALUE[token] ?? "unknown";
}

/** `am get-inactive <pkg>` prints `Idle=true|false`. */
export function parseInactive(output: string): boolean {
  const match = /Idle=(true|false)/i.exec(output);
  if (!match) {
    throw new PowerParseError("am get-inactive output has no Idle= value");
  }
  return match[1]?.toLowerCase() === "true";
}
