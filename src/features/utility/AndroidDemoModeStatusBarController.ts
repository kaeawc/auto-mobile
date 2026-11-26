import type { ExecResult } from "../../models";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { defaultDemoAllowedReceipts, type DemoAllowedReceipts } from "./DemoAllowedReceipts";
import { parseBattery } from "./power/PowerParsers";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { runOutsideRequestContext } from "../../utils/AbortContext";
import { readAndroidEmulatorFlag } from "../../utils/android-cmdline-tools/deviceTraits";
import {
  STATUS_BAR_COMMAND_TIMEOUT_MS,
  StatusBarRequestRejectedError,
  requestedStatusBarFields,
  throwOnExecError,
  type StatusBarApplyOutcome,
  type StatusBarClearOptions,
  type StatusBarController,
  type StatusBarField,
  type StatusBarOverrides,
} from "./StatusBarOverride";

const DEMO_ACTION = "com.android.systemui.demo";
const DEMO_ALLOWED_SETTING = "sysui_demo_allowed";
/** Bound on the battery reset that ends a refresh; it runs even after the clear was aborted. */
export const BATTERY_RESET_TIMEOUT_MS = 5_000;

/** Android's demo clock takes `hhmm`; a 12/24-hour `H:MM` or `HH:MM` maps onto it. */
export function androidDemoClock(time: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return `${String(hours).padStart(2, "0")}${match[2]}`;
}

/**
 * SystemUI demo mode: `settings put global sysui_demo_allowed 1`, then `am broadcast -a
 * com.android.systemui.demo -e command …`. Demo mode has no carrier-name command, so
 * `operatorName` is reported unsupported rather than silently dropped.
 */
export class AndroidDemoModeStatusBarController implements StatusBarController {
  constructor(
    private readonly adb: Pick<AdbExecutor, "execute">,
    private readonly deviceId: string = "",
    private readonly receipts: DemoAllowedReceipts = defaultDemoAllowedReceipts,
  ) {}

  private async shell(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    const result = await this.adb.execute(["shell", ...args], {
      timeoutMs: STATUS_BAR_COMMAND_TIMEOUT_MS,
      signal,
    });
    throwOnExecError(result, `adb shell ${args.join(" ")}`);
    return result;
  }

  private demo(extras: Array<[string, string]>, signal?: AbortSignal): Promise<ExecResult> {
    return this.shell(
      [
        "am",
        "broadcast",
        "-a",
        DEMO_ACTION,
        ...extras.flatMap(([key, value]) => ["-e", key, value]),
      ],
      signal,
    );
  }

  async override(
    overrides: StatusBarOverrides,
    signal?: AbortSignal,
  ): Promise<StatusBarApplyOutcome> {
    const clock = overrides.time === undefined ? undefined : androidDemoClock(overrides.time);
    if (clock === null) {
      throw new StatusBarRequestRejectedError(
        `Android demo mode needs time as H:MM or HH:MM (24-hour), got "${overrides.time}".`,
      );
    }
    const applied: StatusBarField[] = [];
    const unsupported: StatusBarField[] =
      overrides.operatorName === undefined ? [] : ["operatorName"];
    if (requestedStatusBarFields(overrides).length === unsupported.length) {
      // Nothing demo mode can set: leave the device (and demo mode) untouched.
      return { applied, unsupported };
    }
    if (!this.receipts.has(this.deviceId)) {
      this.receipts.save(this.deviceId, await this.readDemoAllowed(signal));
    }
    await this.shell(["settings", "put", "global", DEMO_ALLOWED_SETTING, "1"], signal);
    await this.demo([["command", "enter"]], signal);
    if (clock !== undefined) {
      await this.demo(
        [
          ["command", "clock"],
          ["hhmm", clock],
        ],
        signal,
      );
      applied.push("time");
    }
    await this.applyBattery(overrides, applied, signal);
    await this.applyNetwork(overrides, applied, signal);
    if (overrides.hideNotifications !== undefined) {
      await this.demo(
        [
          ["command", "notifications"],
          ["visible", String(!overrides.hideNotifications)],
        ],
        signal,
      );
      applied.push("hideNotifications");
    }
    return { applied, unsupported };
  }

  private async applyBattery(
    overrides: StatusBarOverrides,
    applied: StatusBarField[],
    signal?: AbortSignal,
  ): Promise<void> {
    if (overrides.batteryLevel === undefined && overrides.batteryState === undefined) {
      return;
    }
    const extras: Array<[string, string]> = [["command", "battery"]];
    if (overrides.batteryLevel !== undefined) {
      extras.push(["level", String(overrides.batteryLevel)]);
      applied.push("batteryLevel");
    }
    if (overrides.batteryState !== undefined) {
      extras.push(["plugged", String(overrides.batteryState === "charging")]);
      applied.push("batteryState");
    }
    await this.demo(extras, signal);
  }

  private async applyNetwork(
    overrides: StatusBarOverrides,
    applied: StatusBarField[],
    signal?: AbortSignal,
  ): Promise<void> {
    const network = overrides.dataNetwork;
    if (overrides.wifiBars !== undefined || network === "wifi") {
      const extras: Array<[string, string]> = [
        ["command", "network"],
        ["wifi", "show"],
      ];
      if (overrides.wifiBars !== undefined) {
        extras.push(["level", String(overrides.wifiBars)]);
        applied.push("wifiBars");
      }
      await this.demo(extras, signal);
    }
    const cellularDatatype =
      network === undefined || network === "wifi"
        ? undefined
        : network === "hide"
          ? "null"
          : network;
    if (overrides.cellularBars !== undefined || cellularDatatype !== undefined) {
      const extras: Array<[string, string]> = [
        ["command", "network"],
        ["mobile", "show"],
      ];
      if (overrides.cellularBars !== undefined) {
        extras.push(["level", String(overrides.cellularBars)]);
        applied.push("cellularBars");
      }
      if (cellularDatatype !== undefined) {
        extras.push(["datatype", cellularDatatype]);
      }
      await this.demo(extras, signal);
    }
    if (network !== undefined) {
      applied.push("dataNetwork");
    }
  }

  async clear(signal?: AbortSignal, options: StatusBarClearOptions = {}): Promise<void> {
    await this.demo([["command", "exit"]], signal);
    const prior = this.receipts.take(this.deviceId);
    if (prior !== undefined) {
      await this.shell(
        prior === null
          ? ["settings", "delete", "global", DEMO_ALLOWED_SETTING]
          : ["settings", "put", "global", DEMO_ALLOWED_SETTING, prior],
        signal,
      );
    }
    await options.beforeBatteryRefresh?.();
    await this.refreshBattery(signal);
  }

  /**
   * SystemUI keeps drawing the demo battery level after `exit` until the next real
   * ACTION_BATTERY_CHANGED (#19189). `dumpsys battery set -f level <current>` forces that
   * broadcast with the level the device already reports; `reset` then hands the battery back
   * to the hardware unless a `dumpsys battery` fake was already active, which is kept. Once the
   * set may have run on an unfaked battery the reset always follows, even when the clear was
   * aborted or the set failed, so the device is never left faked. Physical devices are skipped:
   * AutoMobile does not fake their battery (PowerPlan refuses it).
   */
  private async refreshBattery(signal?: AbortSignal): Promise<void> {
    let resetAfter = false;
    try {
      const emulator = await readAndroidEmulatorFlag(
        async (prop) => (await this.shell(["getprop", prop], signal)).stdout,
      );
      if (emulator !== true) {
        return;
      }
      const battery = parseBattery((await this.shell(["dumpsys", "battery"], signal)).stdout);
      resetAfter = !battery.faked;
      await this.shell(["dumpsys", "battery", "set", "-f", "level", String(battery.level)], signal);
    } catch (error) {
      signal?.throwIfAborted();
      // Demo mode already exited; only the drawn battery level may stay stale until the next
      // real battery broadcast.
      logger.warn(`statusBar clear: battery refresh failed: ${errorMessage(error)}`, error);
    } finally {
      if (resetAfter) {
        await this.resetBattery();
      }
    }
  }

  /** `dumpsys battery reset`, bounded on its own: the caller's signal may already be aborted. */
  private async resetBattery(): Promise<void> {
    const args = ["dumpsys", "battery", "reset"];
    try {
      const result = await runOutsideRequestContext(() =>
        this.adb.execute(["shell", ...args], { timeoutMs: BATTERY_RESET_TIMEOUT_MS }),
      );
      throwOnExecError(result, `adb shell ${args.join(" ")}`);
    } catch (error) {
      logger.warn(
        `statusBar clear: battery reset failed; the battery may stay faked until \`adb shell dumpsys battery reset\`: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /** The `sysui_demo_allowed` value the device holds now, or null when the setting is unset. */
  async readDemoAllowed(signal?: AbortSignal): Promise<string | null> {
    const value = (
      await this.shell(["settings", "get", "global", DEMO_ALLOWED_SETTING], signal)
    ).stdout.trim();
    return value === "" || value === "null" ? null : value;
  }

  async read(signal?: AbortSignal): Promise<string | null> {
    const result = await this.shell(["settings", "get", "global", DEMO_ALLOWED_SETTING], signal);
    return `${DEMO_ALLOWED_SETTING}=${result.stdout.trim()}`;
  }
}
