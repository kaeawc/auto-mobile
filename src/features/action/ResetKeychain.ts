import { ActionableError, toActionableError } from "../../models";
import type { BootedDevice, ExecResult, ResetKeychainResult } from "../../models";
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

export interface ResetKeychainOptions {
  /**
   * The app whose Keychain/Keystore test state the caller intends to reset. The
   * scope is honored per-platform: scoped app-owned resets (physical iOS #5188,
   * Android #5190) address only this app, while the iOS Simulator backend can
   * only reset the whole device (see {@link ResetKeychain}).
   */
  appId: string;
  /**
   * Destructive-operation gate. Because the iOS Simulator backend erases the
   * Keychain for EVERY app on the device, this action refuses to run unless the
   * caller passes `confirm: true`.
   */
  confirm: boolean;
  /**
   * Whether the caller supplied an explicit device-bound selector (a `deviceId`,
   * a `device` label, or a `sessionUuid`) rather than letting the device be
   * ambiently resolved. Device targeting fields are optional at the tool schema
   * boundary, so without this guard `registerDeviceAware` would fall back to an
   * ambient/auto-started simulator — this destructive, device-wide reset must
   * never hit a simulator the caller did not explicitly select (issue #5187).
   */
  explicitlyTargeted: boolean;
}

/**
 * Reset an app's Keychain/Keystore secure-storage test state (issues #5187,
 * #5188, #5190).
 *
 * This is a cross-platform tool with a scoped, per-`appId` contract, but the
 * only backend implemented today is the iOS Simulator's device-wide reset:
 *
 * - **iOS Simulator** → `xcrun simctl keychain <udid> reset`. This is
 *   device-wide: it erases EVERY app's Keychain regardless of the requested
 *   `appId`. The result reports `scope: "all-apps"` and
 *   `exceededRequestedScope: true` so callers are never misled into thinking one
 *   app was targeted.
 * - **Physical iOS** → rejected; a scoped, app-owned reset is tracked in #5188.
 * - **Android** → rejected; a scoped, app-owned Keystore reset is tracked in
 *   #5190.
 *
 * It requires explicit `confirm: true` because the simulator backend is
 * destructive far beyond a single app. Tooling unavailability and command
 * failures surface as {@link ActionableError}.
 */
export class ResetKeychain {
  private device: BootedDevice;
  private simctl: SimctlKeychainClient;

  constructor(device: BootedDevice, simctl: SimctlKeychainClient | null = null) {
    this.device = device;
    this.simctl = simctl ?? new SimCtlClient(device);
  }

  async execute(options: ResetKeychainOptions): Promise<ResetKeychainResult> {
    const deviceId = this.device.deviceId;
    const appId = options.appId;

    // Refuse to run against an ambiently-resolved device. The tool's targeting
    // fields are optional, so without an explicit selector the device layer would
    // reuse the current simulator or auto-start one — a destructive, device-wide
    // Keychain wipe must never land on a simulator the caller did not select.
    if (!options.explicitlyTargeted) {
      throw new ActionableError(
        `Refusing to reset the Keychain without an explicit device target. This is a ` +
          `destructive, device-wide operation, so it will not run against an ambiently ` +
          `selected device. Provide a deviceId, a device label, or a sessionUuid.`,
      );
    }

    if (this.device.platform === "android") {
      // Scoped, app-owned Android Keystore reset is not implemented yet (#5190).
      throw new ActionableError(
        `Scoped Keystore reset for '${appId}' is not yet implemented on Android (tracked in #5190). ` +
          `Only iOS Simulator device-wide Keychain reset is currently supported.`,
      );
    }

    if (this.device.platform !== "ios") {
      throw new ActionableError(
        "Keychain reset is only supported on iOS simulators (Android Keystore support is tracked in #5190)",
      );
    }

    // Reject physical iOS devices: the only supported operation is the
    // simulator's device-wide reset. A scoped, app-owned reset is tracked in #5188.
    if (!isIosSimulatorUdid(deviceId)) {
      throw new ActionableError(
        `Scoped Keychain reset for '${appId}' is not yet implemented on physical iOS devices ` +
          `(tracked in #5188). Only iOS Simulator device-wide reset is currently supported.`,
      );
    }

    if (options.confirm !== true) {
      throw new ActionableError(
        `Refusing to reset the iOS Simulator Keychain without explicit confirmation. ` +
          `iOS Simulator only supports a device-wide reset, so this erases ALL apps' Keychain ` +
          `data on simulator ${deviceId} — not just '${appId}'. Set confirm: true to proceed.`,
      );
    }

    try {
      await this.simctl.executeCommandArgs(["keychain", deviceId, "reset"]);
    } catch (error) {
      throw toActionableError(
        error,
        `Failed to reset the iOS Simulator Keychain on simulator ${deviceId}`,
      );
    }

    return {
      success: true,
      deviceId,
      platform: "ios",
      requestedAppId: appId,
      scope: "all-apps",
      exceededRequestedScope: true,
      message:
        `Reset the iOS Simulator Keychain on simulator ${deviceId}. ` +
        `iOS Simulator only supports a device-wide reset, so EVERY app's Keychain data ` +
        `was erased — not just '${appId}'.`,
    };
  }
}
