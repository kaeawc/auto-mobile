import type { BootedDevice } from "../../models";
import type { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import {
  STATUS_BAR_COMMAND_TIMEOUT_MS,
  throwOnExecError,
  type StatusBarApplyOutcome,
  type StatusBarController,
  type StatusBarField,
  type StatusBarOverrides,
} from "./StatusBarOverride";

/** `xcrun simctl status_bar <udid> override|clear|list`. */
export class SimctlStatusBarController implements StatusBarController {
  constructor(
    private readonly device: BootedDevice,
    private readonly simctl: Pick<SimCtl, "executeCommandArgs">,
  ) {}

  async override(
    overrides: StatusBarOverrides,
    signal?: AbortSignal,
  ): Promise<StatusBarApplyOutcome> {
    const args = ["status_bar", this.device.deviceId, "override"];
    const applied: StatusBarField[] = [];
    const add = (field: StatusBarField, flag: string, value: string | number | undefined) => {
      if (value === undefined) {
        return;
      }
      args.push(flag, String(value));
      applied.push(field);
    };
    add("time", "--time", overrides.time);
    add("batteryLevel", "--batteryLevel", overrides.batteryLevel);
    add("batteryState", "--batteryState", overrides.batteryState);
    if (overrides.cellularBars !== undefined) {
      args.push("--cellularMode", "active");
    }
    add("cellularBars", "--cellularBars", overrides.cellularBars);
    if (overrides.wifiBars !== undefined) {
      args.push("--wifiMode", "active");
    }
    add("wifiBars", "--wifiBars", overrides.wifiBars);
    add("dataNetwork", "--dataNetwork", overrides.dataNetwork);
    add("operatorName", "--operatorName", overrides.operatorName);
    const unsupported: StatusBarField[] =
      overrides.hideNotifications === undefined ? [] : ["hideNotifications"];
    if (applied.length > 0) {
      const result = await this.simctl.executeCommandArgs(
        args,
        STATUS_BAR_COMMAND_TIMEOUT_MS,
        signal,
      );
      throwOnExecError(result, "simctl status_bar override");
    }
    return { applied, unsupported };
  }

  async clear(signal?: AbortSignal): Promise<void> {
    const result = await this.simctl.executeCommandArgs(
      ["status_bar", this.device.deviceId, "clear"],
      STATUS_BAR_COMMAND_TIMEOUT_MS,
      signal,
    );
    throwOnExecError(result, "simctl status_bar clear");
  }

  async read(signal?: AbortSignal): Promise<string | null> {
    const result = await this.simctl.executeCommandArgs(
      ["status_bar", this.device.deviceId, "list"],
      STATUS_BAR_COMMAND_TIMEOUT_MS,
      signal,
    );
    throwOnExecError(result, "simctl status_bar list");
    return result.stdout.trim();
  }
}
