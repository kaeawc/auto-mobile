import type { BootedDevice } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import type { HostProcessExecutor } from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import type { DeviceAppManager } from "../../utils/ios-cmdline-tools/DeviceAppManager";
import {
  resolveIosDeviceBackend,
  type DeviceAppUninstaller,
} from "../../utils/ios-cmdline-tools/IosDeviceBackend";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { SimctlCommandTimeoutError } from "../../utils/ios-cmdline-tools/SimctlCommandTimeoutError";
import type { Timer } from "../../utils/SystemTimer";

/** The device-side CtrlProxy app checks a manager runs around a runner launch. */
export interface IosAppBundleGuard {
  /** One-time removal of the pre-rename CtrlProxy app; best-effort and never throws. */
  uninstallLegacyAppIfPresent(): Promise<void>;
  /** Uninstalls the installed CtrlProxy app when its hash differs from the expected bundle. */
  verifyInstalledAppBundle(): Promise<void>;
}

export interface DefaultIosAppBundleGuardOptions {
  device: BootedDevice;
  /** Reads the installed bundle hash and uninstalls; `DeviceAppManager` satisfies both. */
  deviceAppManager: Pick<DeviceAppManager, "getInstalledAppBundleHash"> & DeviceAppUninstaller;
  processExecutor: HostProcessExecutor;
  timer: Timer;
  appBundleId: string;
  /** Bundle ID used before the rename to CtrlProxy. */
  legacyAppBundleId: string;
  isSimulator(): boolean;
  /** True when the operator opted out of comparing the installed app hash. */
  isHashVerificationSkipped(): boolean;
  getExpectedAppHash(platform: "simulator" | "device"): string | null;
}

export class DefaultIosAppBundleGuard implements IosAppBundleGuard {
  // #6575: the legacy-app uninstall probe is a one-time cleanup for a long-renamed
  // bundle ID; gate it to at most once per guard so repeat setup() calls (including
  // the attemptedSetup fast path) don't pay for a redundant external-process round trip.
  private legacyCheckDone = false;

  constructor(private readonly options: DefaultIosAppBundleGuardOptions) {}

  async uninstallLegacyAppIfPresent(): Promise<void> {
    if (this.legacyCheckDone) {
      return;
    }
    this.legacyCheckDone = true;
    const { legacyAppBundleId } = this.options;
    try {
      const isInstalled = await this.options.deviceAppManager.getInstalledAppBundleHash(
        this.options.device.deviceId,
        legacyAppBundleId,
        this.options.isSimulator(),
        { throwOnLookupTimeout: true },
      );
      if (isInstalled === null) {
        return;
      }
      logger.info(`[IOSCtrlProxy] Found legacy app ${legacyAppBundleId}, uninstalling`);
      await this.uninstall(legacyAppBundleId);
      logger.info(`[IOSCtrlProxy] Legacy app uninstalled`);
    } catch (error) {
      if (error instanceof SimctlCommandTimeoutError) {
        // The lookup was killed, so the legacy app's presence is unknown rather than absent:
        // do not record the check as done, so the next setup looks again.
        this.legacyCheckDone = false;
      }
      logger.warn(`[IOSCtrlProxy] Failed to check/uninstall legacy app: ${error}`);
    }
  }

  async verifyInstalledAppBundle(): Promise<void> {
    if (this.options.isHashVerificationSkipped()) {
      return;
    }

    const simulator = this.options.isSimulator();
    const expectedHash = this.options.getExpectedAppHash(simulator ? "simulator" : "device");
    if (!expectedHash) {
      logger.warn(
        "[IOSCtrlProxy] CtrlProxy app hash verification skipped (no expected hash configured)",
      );
      return;
    }

    const deviceHash = await this.options.deviceAppManager.getInstalledAppBundleHash(
      this.options.device.deviceId,
      this.options.appBundleId,
      simulator,
    );
    if (!deviceHash) {
      logger.warn("[IOSCtrlProxy] Unable to read installed CtrlProxy app hash from device");
      return;
    }

    if (deviceHash.toLowerCase() !== expectedHash.toLowerCase()) {
      logger.warn("[IOSCtrlProxy] Installed CtrlProxy app hash mismatch", {
        deviceHash,
        expectedHash,
      });
      try {
        await this.uninstall(this.options.appBundleId);
        logger.info("[IOSCtrlProxy] Uninstalled CtrlProxy app to force reinstall");
      } catch (error) {
        logger.warn(`[IOSCtrlProxy] Failed to uninstall CtrlProxy app: ${errorMessage(error)}`);
      }
      return;
    }

    logger.info("[IOSCtrlProxy] Installed CtrlProxy app hash matches expected bundle");
  }

  private uninstall(bundleId: string): Promise<void> {
    const { device, deviceAppManager, processExecutor, timer } = this.options;
    return resolveIosDeviceBackend(device.deviceId, {
      simctl: new SimCtlClient(device, (file, args) => processExecutor.executeCommand(file, args), {
        timer,
      }),
      deviceAppUninstaller: deviceAppManager,
    }).uninstallApp(bundleId, undefined, { terminateFirst: false });
  }
}
