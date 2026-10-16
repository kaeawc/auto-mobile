import type { BootedDevice } from "../../../models";
import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { outputLooksLikeShellFailure } from "../../../utils/android-cmdline-tools/shellOutputHeuristics";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { isIosSimulatorDevice } from "../../action/IosSimulatorPermissions";
import { AndroidCtrlProxyClient } from "../../observe/android/AndroidCtrlProxyClient";
import {
  IOS_PHYSICAL_DND_UNSUPPORTED_ERROR,
  IOS_SIM_DND_UNSUPPORTED_ERROR,
  parseAndroidZenMode,
  modeForInput,
  type DoNotDisturbState,
  type DoNotDisturbInput,
} from "./DoNotDisturbState";

interface DoNotDisturbOperationsDependencies {
  device: () => BootedDevice;
  adbFactory: () => AdbClientFactory;
}

export class DoNotDisturbOperations {
  constructor(private readonly dependencies: DoNotDisturbOperationsDependencies) {}

  /** Platform dispatch for reading Do Not Disturb, kept off the getState hot path. */
  readDoNotDisturb(): Promise<DoNotDisturbState> {
    return this.dependencies.device().platform === "android"
      ? this.getAndroidDoNotDisturb()
      : this.getIosDoNotDisturb();
  }

  /** Platform dispatch for writing Do Not Disturb. */
  writeDoNotDisturb(input: DoNotDisturbInput | undefined): Promise<DoNotDisturbState> {
    return this.dependencies.device().platform === "android"
      ? this.setAndroidDoNotDisturb(input)
      : this.setIosDoNotDisturb(input);
  }

  private async getAndroidDoNotDisturb(): Promise<DoNotDisturbState> {
    try {
      const a11y = AndroidCtrlProxyClient.getInstance(this.dependencies.device());
      const a11yResult = await a11y.requestSettingsGet("global", "zen_mode");
      if (a11yResult.success) {
        return parseAndroidZenMode(a11yResult.value ?? "");
      }
    } catch (error) {
      logger.debug(`[DeviceState] a11y zen_mode get failed: ${error}`);
    }
    try {
      const adb = this.dependencies.adbFactory().create(this.dependencies.device());
      const result = await adb.executeCommand(
        "shell settings get global zen_mode",
        undefined,
        undefined,
        true,
      );
      return parseAndroidZenMode(result.stdout);
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        error: errorMessage(error),
      };
    }
  }

  private async setAndroidDoNotDisturb(
    input: DoNotDisturbInput | undefined,
  ): Promise<DoNotDisturbState> {
    const mode = modeForInput(input);
    try {
      const adb = this.dependencies.adbFactory().create(this.dependencies.device());
      const setResult = await adb.executeCommand(
        `shell cmd notification set_dnd ${mode}`,
        undefined,
        undefined,
        true,
      );
      const stdout = setResult.stdout;
      const stderr = setResult.stderr ?? "";
      if (outputLooksLikeShellFailure(stdout, stderr)) {
        return {
          supported: true,
          capability: "full",
          mode,
          method: "android_cmd_notification",
          error: `${stdout}\n${stderr}`.trim() || "cmd notification set_dnd reported an error",
        };
      }
      const state = await this.getAndroidDoNotDisturb();
      const verified = mode === "off" ? state.enabled === false : state.mode === mode;
      return {
        ...state,
        capability: "full",
        method: "android_cmd_notification",
        verified,
        ...(verified
          ? {}
          : {
              warning: `Requested DND mode ${mode}, read back ${state.mode ?? state.rawValue ?? "unknown"}`,
            }),
      };
    } catch (error) {
      return {
        supported: true,
        capability: "full",
        mode,
        method: "android_cmd_notification",
        error: errorMessage(error),
      };
    }
  }

  private async getIosDoNotDisturb(): Promise<DoNotDisturbState> {
    // No iOS target — simulator or physical — can report DND. Simulators are
    // covered by IOS_SIM_DND_UNSUPPORTED_ERROR (donotdisturbd owns the legacy
    // key on every obtainable runtime); physical devices have no public API at
    // all. Neither issues a notifyutil read, because a read would return a
    // confident falsehood (always `0`) rather than the real Focus state.
    return {
      supported: false,
      capability: "unsupported",
      error: isIosSimulatorDevice(this.dependencies.device())
        ? IOS_SIM_DND_UNSUPPORTED_ERROR
        : IOS_PHYSICAL_DND_UNSUPPORTED_ERROR,
    };
  }

  private async setIosDoNotDisturb(
    input: DoNotDisturbInput | undefined,
  ): Promise<DoNotDisturbState> {
    const requestedMode = modeForInput(input);

    // Neither iOS simulators nor physical devices can have DND set. The legacy
    // com.apple.donotdisturb.enabled notification is owned and reset by the
    // donotdisturbd Focus daemon on every runtime we can obtain, so writing it
    // would post a notification that changes nothing and cannot be verified.
    // Return without issuing any notifyutil write rather than reporting a
    // best-effort success that is really a no-op.
    return {
      supported: false,
      capability: "unsupported",
      requestedMode,
      verified: false,
      error: isIosSimulatorDevice(this.dependencies.device())
        ? IOS_SIM_DND_UNSUPPORTED_ERROR
        : IOS_PHYSICAL_DND_UNSUPPORTED_ERROR,
    };
  }
}
