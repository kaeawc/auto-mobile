import type { BootedDevice } from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { PowerCommandError } from "./PowerCommandError";
import {
  dozeReading,
  parseBattery,
  parseBooleanSetting,
  parseDozeEnabled,
  parseDozeState,
  parseInactive,
  parseRestrictBackground,
  parseStandbyBucket,
  parseThermal,
} from "./PowerParsers";
import type {
  BatteryCharging,
  BatteryReading,
  DozeReading,
  ObservedStandbyBucket,
  StandbyBucket,
  ThermalReading,
} from "./PowerTypes";

const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Text the power shell commands print when they fail: most exit 0 and say so on stdout
 * (`Unable to go idle; not enabled`, `Unknown command`, a Java exception).
 */
const FAILURE_OUTPUT =
  /exception|unknown (command|option)|error:|unable to|usage:|bad (value|status)|can't find service|permission denied|not found/i;

/** The power controls a session drives on one device; every method rejects on failure. */
export interface PowerDeviceClient {
  readBattery(): Promise<BatteryReading>;
  setBatteryLevel(level: number): Promise<void>;
  setBatteryCharging(charging: BatteryCharging): Promise<void>;
  resetBattery(): Promise<void>;
  isScreenOn(): Promise<boolean>;
  sleepScreen(): Promise<void>;
  wakeScreen(): Promise<void>;
  isDeepDozeEnabled(): Promise<boolean>;
  isLightDozeEnabled(): Promise<boolean>;
  readDoze(): Promise<DozeReading>;
  forceDoze(mode: "light" | "deep"): Promise<void>;
  unforceDoze(): Promise<void>;
  /** `undefined`: the setting is unset. */
  readBatterySaver(): Promise<boolean | undefined>;
  setBatterySaver(enabled: boolean): Promise<void>;
  readDataSaver(): Promise<boolean>;
  setDataSaver(enabled: boolean): Promise<void>;
  readThermal(): Promise<ThermalReading>;
  overrideThermal(status: number): Promise<void>;
  resetThermal(): Promise<void>;
  readStandbyBucket(appId: string): Promise<ObservedStandbyBucket>;
  setStandbyBucket(appId: string, bucket: StandbyBucket): Promise<void>;
  readInactive(appId: string): Promise<boolean>;
  setInactive(appId: string, inactive: boolean): Promise<void>;
}

export type PowerClientFactory = (device: BootedDevice) => PowerDeviceClient;

type PowerAdb = Pick<AdbExecutor, "execute" | "isScreenOn">;

/** {@link PowerDeviceClient} over adb: `dumpsys battery`/`deviceidle`/`thermalservice`, `cmd`, `am`, `settings`. */
export class AdbPowerClient implements PowerDeviceClient {
  constructor(private readonly adb: PowerAdb) {}

  private async shell(args: string[], mustSucceed = true): Promise<string> {
    const result = await this.adb.execute(["shell", ...args], {
      noRetry: true,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (mustSucceed && FAILURE_OUTPUT.test(output)) {
      throw new PowerCommandError(`${args.slice(0, 3).join(" ")} failed: ${output.slice(0, 200)}`);
    }
    return result.stdout;
  }

  async readBattery(): Promise<BatteryReading> {
    return parseBattery(await this.shell(["dumpsys", "battery"], false));
  }

  async setBatteryLevel(level: number): Promise<void> {
    await this.shell(["dumpsys", "battery", "set", "level", String(level)]);
  }

  async setBatteryCharging(charging: BatteryCharging): Promise<void> {
    if (charging === "none") {
      await this.shell(["dumpsys", "battery", "unplug"]);
      await this.shell(["dumpsys", "battery", "set", "status", "3"]);
      return;
    }
    // One source at a time: leaving another charger on would report two.
    for (const source of ["ac", "usb", "wireless"]) {
      await this.shell(["dumpsys", "battery", "set", source, source === charging ? "1" : "0"]);
    }
    await this.shell(["dumpsys", "battery", "set", "status", "2"]);
  }

  async resetBattery(): Promise<void> {
    await this.shell(["dumpsys", "battery", "reset"]);
  }

  isScreenOn(): Promise<boolean> {
    return this.adb.isScreenOn();
  }

  async sleepScreen(): Promise<void> {
    await this.shell(["input", "keyevent", "KEYCODE_SLEEP"]);
  }

  async wakeScreen(): Promise<void> {
    await this.shell(["input", "keyevent", "KEYCODE_WAKEUP"]);
  }

  async isDeepDozeEnabled(): Promise<boolean> {
    return parseDozeEnabled(await this.shell(["dumpsys", "deviceidle", "enabled", "deep"]));
  }

  async isLightDozeEnabled(): Promise<boolean> {
    return parseDozeEnabled(await this.shell(["dumpsys", "deviceidle", "enabled", "light"]));
  }

  async readDoze(): Promise<DozeReading> {
    const deep = parseDozeState(await this.shell(["dumpsys", "deviceidle", "get", "deep"]));
    const light = parseDozeState(await this.shell(["dumpsys", "deviceidle", "get", "light"]));
    return dozeReading(deep, light);
  }

  async forceDoze(mode: "light" | "deep"): Promise<void> {
    const output = await this.shell(["dumpsys", "deviceidle", "force-idle", mode]);
    if (!/forced in to/i.test(output)) {
      throw new PowerCommandError(
        `deviceidle force-idle ${mode} was not accepted: ${output.trim()}`,
      );
    }
  }

  async unforceDoze(): Promise<void> {
    await this.shell(["dumpsys", "deviceidle", "unforce"]);
  }

  async readBatterySaver(): Promise<boolean | undefined> {
    return parseBooleanSetting(await this.shell(["settings", "get", "global", "low_power"]));
  }

  async setBatterySaver(enabled: boolean): Promise<void> {
    await this.shell(["settings", "put", "global", "low_power", enabled ? "1" : "0"]);
  }

  async readDataSaver(): Promise<boolean> {
    return parseRestrictBackground(
      await this.shell(["cmd", "netpolicy", "get", "restrict-background"]),
    );
  }

  async setDataSaver(enabled: boolean): Promise<void> {
    await this.shell(["cmd", "netpolicy", "set", "restrict-background", String(enabled)]);
  }

  async readThermal(): Promise<ThermalReading> {
    return parseThermal(await this.shell(["dumpsys", "thermalservice"], false));
  }

  async overrideThermal(status: number): Promise<void> {
    await this.shell(["cmd", "thermalservice", "override-status", String(status)]);
  }

  async resetThermal(): Promise<void> {
    await this.shell(["cmd", "thermalservice", "reset"]);
  }

  async readStandbyBucket(appId: string): Promise<ObservedStandbyBucket> {
    return parseStandbyBucket(await this.shell(["am", "get-standby-bucket", appId]));
  }

  async setStandbyBucket(appId: string, bucket: StandbyBucket): Promise<void> {
    await this.shell(["am", "set-standby-bucket", appId, bucket]);
  }

  async readInactive(appId: string): Promise<boolean> {
    return parseInactive(await this.shell(["am", "get-inactive", appId]));
  }

  async setInactive(appId: string, inactive: boolean): Promise<void> {
    await this.shell(["am", "set-inactive", appId, String(inactive)]);
  }
}

export const defaultPowerClientFactory =
  (adbFactory: AdbClientFactory = defaultAdbClientFactory): PowerClientFactory =>
  (device) =>
    new AdbPowerClient(adbFactory.create(device));
