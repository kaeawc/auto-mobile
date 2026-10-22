import type { Timer } from "../../../utils/SystemTimer";
import type { PowerDeviceClient } from "./AndroidPowerClient";
import type { SessionPower } from "./PowerRegistry";
import type { PowerField, SetPowerInput } from "./PowerTypes";

const SCREEN_OFF_POLLS = 5;
const SCREEN_OFF_POLL_MS = 300;

/** One change to the device: the baseline read first, then the write. */
export interface PowerStep {
  field: PowerField;
  /** A failed step skips the later steps of its group (Doze needs its preconditions). */
  group?: string;
  /** Read the value this step replaces, once per field per record. */
  capture(): Promise<void>;
  run(): Promise<void>;
}

export interface PowerStepContext {
  client: PowerDeviceClient;
  record: SessionPower;
  timer: Pick<Timer, "sleep">;
  /** Steps taken only so the request could apply, in order. */
  preconditions: string[];
}

function battery(input: NonNullable<SetPowerInput["battery"]>, ctx: PowerStepContext): PowerStep {
  const { client, record } = ctx;
  return {
    field: "battery",
    capture: async () => {
      record.baseline.battery ??= await client.readBattery();
    },
    run: async () => {
      if (input.reset) {
        await client.resetBattery();
        return;
      }
      if (input.charging) {
        await client.setBatteryCharging(input.charging);
      }
      if (input.level !== undefined) {
        await client.setBatteryLevel(input.level);
      }
    },
  };
}

/** Doze needs an unplugged device: unplug it unless the caller already did or it already is. */
function unplug(ctx: PowerStepContext): PowerStep {
  const { client, record } = ctx;
  return {
    field: "battery",
    group: "doze",
    capture: async () => {
      record.baseline.battery ??= await client.readBattery();
    },
    run: async () => {
      if ((await client.readBattery()).charging === "none") {
        return;
      }
      await client.setBatteryCharging("none");
      ctx.preconditions.push("battery unplugged (dumpsys battery unplug)");
    },
  };
}

/** Doze needs the screen off; turn it off if it is on and remember to turn it back on. */
function screenOff(ctx: PowerStepContext): PowerStep {
  const { client, record } = ctx;
  return {
    field: "screen",
    group: "doze",
    capture: async () => {
      record.baseline.screenOn ??= await client.isScreenOn();
    },
    run: async () => {
      if (!(await client.isScreenOn())) {
        return;
      }
      record.screenSlept = true;
      await client.sleepScreen();
      for (let poll = 0; poll < SCREEN_OFF_POLLS && (await client.isScreenOn()); poll++) {
        await ctx.timer.sleep(SCREEN_OFF_POLL_MS);
      }
      ctx.preconditions.push("screen turned off (KEYCODE_SLEEP)");
    },
  };
}

function doze(mode: NonNullable<SetPowerInput["doze"]>, ctx: PowerStepContext): PowerStep {
  const { client, record } = ctx;
  return {
    field: "doze",
    group: mode === "off" ? undefined : "doze",
    capture: async () => {
      record.baseline.doze ??= (await client.readDoze()).mode;
    },
    run: async () => {
      if (mode === "off") {
        await client.unforceDoze();
        return;
      }
      await client.forceDoze(mode);
    },
  };
}

function batterySaver(enabled: boolean, ctx: PowerStepContext): PowerStep {
  const { client, record } = ctx;
  return {
    field: "batterySaver",
    capture: async () => {
      // null is a recorded value (the setting was unset), so `??=` would overwrite it.
      if (record.baseline.batterySaver === undefined) {
        record.baseline.batterySaver = (await client.readBatterySaver()) ?? null;
      }
    },
    run: () => client.setBatterySaver(enabled),
  };
}

function dataSaver(enabled: boolean, ctx: PowerStepContext): PowerStep {
  const { client, record } = ctx;
  return {
    field: "dataSaver",
    capture: async () => {
      record.baseline.dataSaver ??= await client.readDataSaver();
    },
    run: () => client.setDataSaver(enabled),
  };
}

function thermal(
  status: NonNullable<SetPowerInput["thermalStatus"]>,
  ctx: PowerStepContext,
): PowerStep {
  const { client, record } = ctx;
  return {
    field: "thermal",
    capture: async () => {
      record.baseline.thermal ??= await client.readThermal();
    },
    run: () => (status === "reset" ? client.resetThermal() : client.overrideThermal(status)),
  };
}

function standby(
  input: NonNullable<SetPowerInput["standbyBucket"]>,
  ctx: PowerStepContext,
): PowerStep {
  const { client, record } = ctx;
  return {
    field: "standby",
    capture: async () => {
      const buckets = (record.baseline.standby ??= {});
      buckets[input.appId] ??= await client.readStandbyBucket(input.appId);
    },
    run: () => client.setStandbyBucket(input.appId, input.bucket),
  };
}

function inactive(
  input: NonNullable<SetPowerInput["appInactive"]>,
  ctx: PowerStepContext,
): PowerStep {
  const { client, record } = ctx;
  return {
    field: "inactive",
    capture: async () => {
      const states = (record.baseline.inactive ??= {});
      states[input.appId] ??= await client.readInactive(input.appId);
    },
    run: () => client.setInactive(input.appId, input.inactive),
  };
}

function when<T>(value: T | undefined, build: (value: T) => PowerStep): PowerStep | undefined {
  return value === undefined ? undefined : build(value);
}

/**
 * The ordered steps that apply `input`. Battery first, then the Doze preconditions (unplug,
 * screen off) and Doze itself, then the independent controls.
 */
export function buildPowerSteps(input: SetPowerInput, ctx: PowerStepContext): PowerStep[] {
  const forcedDoze = input.doze === "light" || input.doze === "deep";
  const needsUnplug = forcedDoze && input.battery?.charging !== "none";
  return [
    when(input.battery, (value) => battery(value, ctx)),
    when(needsUnplug || undefined, () => unplug(ctx)),
    when(forcedDoze || undefined, () => screenOff(ctx)),
    when(input.doze, (value) => doze(value, ctx)),
    when(input.batterySaver, (value) => batterySaver(value, ctx)),
    when(input.dataSaver, (value) => dataSaver(value, ctx)),
    when(input.thermalStatus, (value) => thermal(value, ctx)),
    when(input.standbyBucket, (value) => standby(value, ctx)),
    when(input.appInactive, (value) => inactive(value, ctx)),
  ].filter((step): step is PowerStep => step !== undefined);
}
