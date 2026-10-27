import type { PowerDeviceClient } from "../../features/utility/power/AndroidPowerClient";
import { settleDoze } from "../../features/utility/power/PowerSettle";
import { toActionableError } from "../../models/ActionableError";
import type { BackoffPolicy } from "../../utils/Backoff";
import type { Timer } from "../../utils/SystemTimer";
import { z } from "zod/v4";
import { DEVICE_CLOCK_TOLERANCE_MS } from "../../features/utility/DeviceClock";
import {
  BATTERY_CHARGING_VALUES,
  DOZE_MODES,
  STANDBY_BUCKETS,
  type BatteryCharging,
} from "../../features/utility/power/PowerTypes";
import { shellQuote } from "../../utils/shellQuote";
import { parsePowerIntentKey, type PowerIntent } from "./mutations/deviceStateKeys";
import type { DeviceMutationInput } from "./mutations/types";

/**
 * Android reverts for the `setDeviceState` intents (#14359), kept out of the port so the port
 * only wires them. Each returns null unless the journaled prior is the exact shape the prior
 * reader records, so an unreadable or foreign prior is never "restored".
 */
export interface DeviceStateRevertCommand {
  command: string;
  success?: string;
  timeoutMs?: number;
  /** After this command succeeds, wake the screen if it is off (a Doze unforce, #15168). */
  wakeSleptScreen?: boolean;
}

type Commands = DeviceStateRevertCommand[] | null;

function priorOf(mutation: DeviceMutationInput): unknown {
  return mutation.priorValue.state === "present" ? mutation.priorValue.value : undefined;
}

const enabledWord = (on: boolean) => (on ? "enable" : "disable");

const CONNECTIVITY_REVERTS: Readonly<Record<string, (on: boolean) => string>> = {
  airplaneMode: (on) => `shell cmd connectivity airplane-mode ${enabledWord(on)}`,
  wifiEnabled: (on) => `shell svc wifi ${enabledWord(on)}`,
  bluetoothEnabled: (on) => `shell svc bluetooth ${enabledWord(on)}`,
  locationEnabled: (on) => `shell cmd location set-location-enabled ${on}`,
};

const DND_MODES = z.enum(["off", "none", "priority", "alarms"]);

const batterySchema = z.object({
  level: z.number().int().min(0).max(100),
  charging: z.enum(BATTERY_CHARGING_VALUES),
  faked: z.boolean(),
});

const thermalSchema = z.object({ status: z.number().int().min(0).max(6), override: z.boolean() });

function fakeCharging(charging: BatteryCharging): string[] {
  if (charging === "none") {
    return ["shell dumpsys battery unplug", "shell dumpsys battery set status 3"];
  }
  return [
    ...["ac", "usb", "wireless"].map(
      (source) => `shell dumpsys battery set ${source} ${source === charging ? 1 : 0}`,
    ),
    "shell dumpsys battery set status 2",
  ];
}

function batteryCommands(prior: unknown): Commands {
  const battery = batterySchema.safeParse(prior);
  if (!battery.success) {
    return null;
  }
  const { level, charging, faked } = battery.data;
  // A battery nothing faked goes back to its real values; a faked one to the fake it had.
  return (
    faked
      ? [...fakeCharging(charging), `shell dumpsys battery set level ${level}`]
      : ["shell dumpsys battery reset"]
  ).map((command) => ({ command }));
}

function dozeCommands(prior: unknown): Commands {
  const mode = z.enum(DOZE_MODES).safeParse(prior);
  if (!mode.success) {
    return null;
  }
  // Forcing deep Doze sleeps a lit screen and it only reads ACTIVE again once awake, so wake
  // right after the unforce, before the read-back (#15168, as the session restore in #15165).
  return [
    { command: "shell dumpsys deviceidle unforce", wakeSleptScreen: true },
    ...(mode.data === "off"
      ? []
      : [{ command: `shell dumpsys deviceidle force-idle ${mode.data}` }]),
  ];
}

function thermalCommands(prior: unknown): Commands {
  const thermal = thermalSchema.safeParse(prior);
  if (!thermal.success) {
    return null;
  }
  return [
    {
      command: thermal.data.override
        ? `shell cmd thermalservice override-status ${thermal.data.status}`
        : "shell cmd thermalservice reset",
    },
  ];
}

function batterySaverCommands(mutation: DeviceMutationInput, prior: unknown): Commands {
  if (mutation.priorValue.state === "absent") {
    return [{ command: "shell settings delete global low_power" }];
  }
  return typeof prior === "boolean"
    ? [{ command: `shell settings put global low_power ${prior ? 1 : 0}` }]
    : null;
}

function appBucketCommands(intent: PowerIntent & { appId: string }, prior: unknown): Commands {
  if (intent.field === "inactive") {
    return typeof prior === "boolean"
      ? [{ command: `shell am set-inactive ${shellQuote(intent.appId)} ${prior}` }]
      : null;
  }
  const bucket = z.enum(STANDBY_BUCKETS).safeParse(prior);
  return bucket.success
    ? [{ command: `shell am set-standby-bucket ${shellQuote(intent.appId)} ${bucket.data}` }]
    : null;
}

function powerCommands(intent: PowerIntent, mutation: DeviceMutationInput): Commands {
  const prior = priorOf(mutation);
  switch (intent.field) {
    case "battery":
      return batteryCommands(prior);
    case "doze":
      return dozeCommands(prior);
    case "thermal":
      return thermalCommands(prior);
    case "dataSaver":
      return typeof prior === "boolean"
        ? [{ command: `shell cmd netpolicy set restrict-background ${prior}` }]
        : null;
    case "batterySaver":
      return batterySaverCommands(mutation, prior);
    case "standby":
    case "inactive":
      return appBucketCommands(intent, prior);
  }
}

type PowerVerification = (
  client: PowerDeviceClient,
  ctx: { timer: Pick<Timer, "sleep" | "now">; backoff: BackoffPolicy; budgetMs: number },
) => Promise<string | null>;

function batteryVerification(prior: unknown): PowerVerification {
  const before = batterySchema.parse(prior);
  return async (client) => {
    const now = await client.readBattery();
    const matches = before.faked
      ? now.level === before.level && now.charging === before.charging
      : !now.faked;
    return matches ? null : "battery differs from its prior state";
  };
}

function thermalVerification(prior: unknown): PowerVerification {
  const before = thermalSchema.parse(prior);
  return async (client) => {
    const now = await client.readThermal();
    const matches = before.override ? now.override && now.status === before.status : !now.override;
    return matches ? null : "thermal override differs from its prior state";
  };
}

function dozeVerification(prior: unknown): PowerVerification {
  const mode = z.enum(DOZE_MODES).parse(prior);
  return async (client, ctx) => {
    // settleDoze retains the last reading on read failure; reset must also propagate that failure.
    let readError: Error | undefined;
    const settlement = await settleDoze(
      {
        readDoze: async () => {
          try {
            return await client.readDoze();
          } catch (error) {
            readError = toActionableError(error, "Android reset could not read back device state");
            throw readError;
          }
        },
      },
      mode,
      { ...ctx, reading: await client.readDoze() },
    );
    if (readError) {
      throw readError;
    }
    return settlement.settled ? null : `Doze is ${settlement.reading.mode}, expected ${mode}`;
  };
}

function powerVerification(intent: PowerIntent, prior: unknown): PowerVerification {
  switch (intent.field) {
    case "battery":
      return batteryVerification(prior);
    case "thermal":
      return thermalVerification(prior);
    case "doze":
      return dozeVerification(prior);
    case "dataSaver":
      return async (client) =>
        (await client.readDataSaver()) === prior ? null : "Data Saver differs from its prior state";
    case "batterySaver":
      return async (client) => {
        const now = await client.readBatterySaver();
        const matches = prior === undefined ? (now ?? false) === false : now === prior;
        return matches ? null : "battery saver differs from its prior state";
      };
    case "standby":
      return async (client) =>
        (await client.readStandbyBucket(intent.appId)) === prior
          ? null
          : "standby bucket differs from its prior state";
    case "inactive":
      return async (client) =>
        (await client.readInactive(intent.appId)) === prior
          ? null
          : "inactive state differs from its prior state";
  }
}

/** Verify only power priors the command builders can restore. */
export function deviceStatePowerVerification(
  mutation: DeviceMutationInput,
): PowerVerification | null {
  if (mutation.kind !== "device-setting") {
    return null;
  }
  const intent = parsePowerIntentKey(mutation.key);
  return intent && powerCommands(intent, mutation) !== null
    ? powerVerification(intent, priorOf(mutation))
    : null;
}

/**
 * `device-setting` rows the tool vocabulary names rather than a settings-provider key: the
 * connectivity toggles, Do Not Disturb and the power controls. (Airplane mode, Wi-Fi, location and
 * Do Not Disturb are also restored by the baseline settings clean; Bluetooth is not, because a
 * `settings put` does not toggle the radio, and the power controls live in system_server state.)
 */
export function deviceStateSettingCommands(mutation: DeviceMutationInput): Commands {
  const prior = priorOf(mutation);
  if (Object.hasOwn(CONNECTIVITY_REVERTS, mutation.key)) {
    return typeof prior === "boolean"
      ? [{ command: CONNECTIVITY_REVERTS[mutation.key]!(prior) }]
      : null;
  }
  if (mutation.key === "doNotDisturb") {
    const mode = DND_MODES.safeParse(prior);
    return mode.success ? [{ command: `shell cmd notification set_dnd ${mode.data}` }] : null;
  }
  const intent = parsePowerIntentKey(mutation.key);
  return intent ? powerCommands(intent, mutation) : null;
}

const networkValuesSchema = z.object({
  delayMs: z.number().min(0).optional(),
  downloadKbps: z.number().min(0).optional(),
  uploadKbps: z.number().min(0).optional(),
});

/**
 * Device-wide emulator shaping goes back to the status read before the session shaped it
 * (`full`/`none` when that status was unshaped), with the radios the shaping toggles back on.
 */
export function networkConditionCommands(mutation: DeviceMutationInput): Commands {
  const values = networkValuesSchema.safeParse(priorOf(mutation));
  if (mutation.key !== "device" || !values.success) {
    return null;
  }
  const { delayMs = 0, downloadKbps = 0, uploadKbps = 0 } = values.data;
  const delay = delayMs > 0 ? `${delayMs}:${delayMs}` : "none";
  const speed = downloadKbps > 0 || uploadKbps > 0 ? `${uploadKbps}:${downloadKbps}` : "full";
  return [
    { command: `emu network delay ${delay}`, success: "OK" },
    { command: `emu network speed ${speed}`, success: "OK" },
    { command: "emu gsm data on", success: "OK" },
    { command: "shell svc wifi enable" },
  ];
}

const clockPriorSchema = z.object({
  instant: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  automaticTime: z.boolean(),
});

/**
 * Wall-clock restore for the daemon-restart case, where the session's in-memory restore slot is
 * gone: put the device back to host time (only when it has drifted past the clock tolerance, so a
 * session that already restored it needs no root) and its original `auto_time`. Moving the clock
 * needs root; on an unrooted device the write fails and keep-booted reset escalates.
 */
export function clockCommands(mutation: DeviceMutationInput, hostNowMs: number): Commands {
  const prior = clockPriorSchema.safeParse(priorOf(mutation));
  if (mutation.key !== "device" || !prior.success) {
    return null;
  }
  const host = Math.floor(hostNowMs / 1000);
  const toleranceSeconds = Math.ceil(DEVICE_CLOCK_TOLERANCE_MS / 1000);
  const script = [
    `cur=$(date +%s); diff=$((cur - ${host}))`,
    `if [ "$diff" -gt ${toleranceSeconds} ] || [ "$diff" -lt -${toleranceSeconds} ]; then settings put global auto_time 0 && date -u @${host}; fi`,
    `settings put global auto_time ${prior.data.automaticTime ? 1 : 0}`,
  ].join("; ");
  return [{ command: `shell sh -c ${shellQuote(script)}` }];
}
