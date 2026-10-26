import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import type { HostProcessExecutor } from "../../utils/HostCommandExecutor";
import { logger } from "../../utils/logger";
import {
  getSharedDevicectlDeviceLister,
  type IosPhysicalDeviceLister,
} from "../../utils/ios-cmdline-tools/DevicectlDeviceLister";
import { parseSimctlDeviceList } from "../../utils/ios-cmdline-tools/simctlDeviceList";
import { buildSimctlArgs } from "../../utils/ios-cmdline-tools/simctlArgs";
import type { Timer } from "../../utils/SystemTimer";

const USB_RECHECK_DELAY_MS = 500;

type RemoteListing = Promise<{ success: boolean; data?: { stdout: string } }>;

/** The slice of the host-control runner that device detection reads. */
export interface RemoteDeviceListingRunner {
  runIdeviceId(args: string[]): RemoteListing;
  runSimctl(args: string[]): RemoteListing;
}

export interface IosDeviceDetectorOptions {
  deviceId: string;
  processExecutor: HostProcessExecutor;
  timer: Timer;
  remoteRunner: RemoteDeviceListingRunner;
  useRemoteRunner(): boolean;
  isSimulator(): boolean;
  /** Authoritative physical-device inventory (devicectl); defaults to the shared lister. */
  physicalDeviceLister?: IosPhysicalDeviceLister;
}

/** Decides whether the iOS device a CtrlProxy manager targets is still attached. */
/** Pseudo-state of a simulator that a complete `simctl list` no longer shows (deleted). */
export const SIMULATOR_STATE_ABSENT = "Absent";

export class IosDeviceDetector {
  private warnedIdeviceIdUnavailable = false;

  constructor(private readonly options: IosDeviceDetectorOptions) {}

  /**
   * Unknown listings never establish a simulator state. A complete, non-empty listing that does
   * not name this simulator proves it was deleted: {@link SIMULATOR_STATE_ABSENT} (#15309).
   */
  async getSimulatorState(): Promise<string | undefined> {
    try {
      let stdout: string;
      if (this.options.useRemoteRunner()) {
        const result = await this.options.remoteRunner.runSimctl(["list", "devices", "--json"]);
        if (!result.success || !result.data) {
          return undefined;
        }
        stdout = result.data.stdout;
      } else {
        ({ stdout } = await this.options.processExecutor.executeCommand(
          "xcrun",
          buildSimctlArgs(["list", "devices", "--json"]),
        ));
      }
      if (!stdout.trim()) {
        return undefined;
      }
      const listing = parseSimctlDeviceList(stdout);
      if (!listing.devices || Array.isArray(listing.devices)) {
        return undefined;
      }
      const listed = Object.values(listing.devices).filter(Array.isArray).flat();
      const device = listed.find((device) => device?.udid === this.options.deviceId);
      if (!device) {
        // An empty listing is a CoreSimulator hiccup as often as an empty fleet: not evidence.
        return listed.length > 0 ? SIMULATOR_STATE_ABSENT : undefined;
      }
      return typeof device.state === "string" && device.state.trim() ? device.state : undefined;
    } catch (error) {
      // Unknown simulator state cannot justify blocking a launch or retiring a runner.
      logger.debug(`[IOSCtrlProxy] Simulator state probe failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  /** Only a positive shutdown or deletion listing may prevent a runner launch. */
  async isSimulatorShutDown(): Promise<boolean> {
    const state = await this.getSimulatorState();
    return state === "Shutdown" || state === "Shutting Down" || state === SIMULATOR_STATE_ABSENT;
  }

  async isDeviceDetected(): Promise<boolean> {
    if (this.options.isSimulator()) {
      return this.isSimulatorDetected();
    }

    if (this.options.useRemoteRunner()) {
      try {
        const result = await this.options.remoteRunner.runIdeviceId(["-l"]);
        if (!result.success || !result.data) {
          return false;
        }
        return this.listsDevice(result.data.stdout);
      } catch (error) {
        logger.warn(`[IOSCtrlProxy] Remote idevice_id probe failed: ${errorMessage(error)}`, error);
        return false;
      }
    }

    // `idevice_id -l` lists USB devices only, so a miss is not evidence the device
    // is gone (Wi-Fi iPhone, missing libimobiledevice). Only a complete devicectl
    // inventory that omits the device may stop the tunnel.
    if (await this.isUsbListed(["-l"])) {
      return true;
    }
    return this.isPresentInDevicectlInventory();
  }

  /**
   * The iproxy tunnel here is USB-only (no `-n`), so a device reachable only over
   * Wi-Fi can never be forwarded. Reject it up front with an actionable error
   * rather than starting a tunnel that cannot connect.
   */
  async assertUsbAttachedForTunnel(): Promise<void> {
    if (await this.isUsbListed(["-l"])) {
      return;
    }
    if (await this.isUsbListed(["-l", "-n"])) {
      // A cabled phone with Wi-Fi sync can be listed by `-n` while transiently
      // missing from `-l`; re-probe USB once before calling it Wi-Fi only (#11186).
      await this.options.timer.sleep(USB_RECHECK_DELAY_MS);
      if (await this.isUsbListed(["-l"])) {
        return;
      }
      throw new ActionableError(
        `iOS device ${this.options.deviceId} is reachable over Wi-Fi only. The CtrlProxy tunnel ` +
          "requires a USB connection; connect the device with a cable and retry.",
      );
    }
  }

  private listsDevice(stdout: string): boolean {
    return stdout.split("\n").some((line) => line.trim() === this.options.deviceId);
  }

  /** True when `idevice_id` lists this device; false on a miss or a failed probe. */
  private async isUsbListed(args: string[]): Promise<boolean> {
    try {
      const { stdout } = await this.options.processExecutor.executeCommand("idevice_id", args);
      return this.listsDevice(stdout);
    } catch (error) {
      if (!this.warnedIdeviceIdUnavailable) {
        this.warnedIdeviceIdUnavailable = true;
        logger.warn(
          `[IOSCtrlProxy] idevice_id probe failed (is libimobiledevice installed?): ${errorMessage(error)}`,
          error,
        );
      }
      return false;
    }
  }

  private async isPresentInDevicectlInventory(): Promise<boolean> {
    const lister = this.options.physicalDeviceLister ?? getSharedDevicectlDeviceLister();
    const listing = await lister.listConnectedDevices();
    if (!listing.complete) {
      // A failed or drifted listing is not authoritative; keep the tunnel.
      return true;
    }
    return listing.devices.some((device) => device.deviceId === this.options.deviceId);
  }

  private async isSimulatorDetected(): Promise<boolean> {
    try {
      if (this.options.useRemoteRunner()) {
        const result = await this.options.remoteRunner.runSimctl(["list", "devices"]);
        if (!result.success || !result.data) {
          return false;
        }
        return result.data.stdout.includes(this.options.deviceId);
      }

      const { stdout } = await this.options.processExecutor.executeCommand(
        "xcrun",
        buildSimctlArgs(["list", "devices"]),
      );
      return stdout.includes(this.options.deviceId);
    } catch (error) {
      // `xcrun simctl list devices` failing (Xcode tooling missing/misconfigured)
      // means we can't confirm the simulator is present; treat it as undetected.
      logger.debug(`src/ctrlProxy/ios/IosDeviceDetector.ts fallback failed: ${error}`, error);
      return false;
    }
  }
}
