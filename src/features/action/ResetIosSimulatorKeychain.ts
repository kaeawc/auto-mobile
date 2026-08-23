import { ActionableError, toActionableError } from "../../models";
import type { BootedDevice, ExecResult, ResetIosSimulatorKeychainResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";

/**
 * Minimal simctl seam this action needs: run a pre-split simctl argv and return
 * its {@link ExecResult}. Narrower than the full {@link SimCtlClient} so tests can
 * inject a fake (issue #5187).
 */
export interface SimctlKeychainClient {
  executeCommandArgs(args: string[], timeoutMs?: number): Promise<ExecResult>;
}

export interface ResetIosSimulatorKeychainOptions {
  /**
   * Destructive-operation gate. This action erases the Keychain for every app on
   * the simulator, so it refuses to run unless the caller passes `confirm: true`.
   */
  confirm: boolean;
}

/**
 * Explicitly reset the Keychain on one iOS simulator via
 * `xcrun simctl keychain <udid> reset` (issue #5187).
 *
 * This is a device-wide, simulator-only, destructive operation:
 * - It targets the explicitly selected simulator UDID; it never falls back to an
 *   ambient booted simulator (the caller resolves the device before construction).
 * - Physical-device and non-iOS targets are rejected before any command runs.
 * - It requires explicit `confirm: true` because it erases EVERY app's Keychain
 *   data on that simulator, not one app's credentials.
 * - Tooling unavailability and command failures surface as {@link ActionableError}.
 */
export class ResetIosSimulatorKeychain {
  private device: BootedDevice;
  private simctl: SimctlKeychainClient;

  constructor(device: BootedDevice, simctl: SimctlKeychainClient | null = null) {
    this.device = device;
    this.simctl = simctl ?? new SimCtlClient(device);
  }

  async execute(options: ResetIosSimulatorKeychainOptions): Promise<ResetIosSimulatorKeychainResult> {
    const deviceId = this.device.deviceId;

    if (this.device.platform !== "ios") {
      throw new ActionableError("iOS Simulator Keychain reset is only supported on iOS simulators");
    }

    // Reject physical iOS devices before execution — the supported simctl
    // keychain-reset operation only exists for simulators.
    if (!isIosSimulatorUdid(deviceId)) {
      throw new ActionableError(
        "iOS Simulator Keychain reset is only supported on simulators, not physical iOS devices"
      );
    }

    if (options.confirm !== true) {
      throw new ActionableError(
        `Refusing to reset the iOS Simulator Keychain without explicit confirmation. ` +
          `This erases ALL apps' Keychain data on simulator ${deviceId}. Set confirm: true to proceed.`
      );
    }

    try {
      await this.simctl.executeCommandArgs(["keychain", deviceId, "reset"]);
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to reset the iOS Simulator Keychain on simulator ${deviceId}`
      );
    }

    return {
      success: true,
      deviceId,
      platform: "ios",
      scope: "all-apps",
      message:
        `Reset the iOS Simulator Keychain on simulator ${deviceId}. ` +
        `Every app's Keychain data on this simulator has been erased.`,
    };
  }
}
