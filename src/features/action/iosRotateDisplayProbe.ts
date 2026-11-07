import type { Timer } from "../../utils/SystemTimer";
import { awaitWhileRequestIsLive } from "../../utils/toolUtils";
import { reconcileIosRotationWithDisplayRead } from "./iosRotateVerification";
import type { BootedDevice, ObserveResult, RotateResult } from "../../models";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { readImageHeaderDimensions } from "../../utils/screenshot/imageHeaderDimensions";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { isIosSimulatorDevice } from "./IosSimulatorPermissions";

export interface IosDisplayPixelProbe {
  readPixelSize(
    deviceId: string,
    displayKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ width: number; height: number } | undefined>;
}

export class SimulatorIosDisplayPixelProbe implements IosDisplayPixelProbe {
  constructor(
    private readonly device: BootedDevice,
    private readonly screenshotClient?: Pick<SimCtlClient, "screenshot">,
  ) {}

  async readPixelSize(
    deviceId: string,
    displayKey: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ width: number; height: number } | undefined> {
    if (!isIosSimulatorDevice(this.device)) {
      return undefined;
    }
    try {
      const pixels = await (this.screenshotClient ?? new SimCtlClient(this.device)).screenshot(
        deviceId,
        displayKey,
        signal,
      );
      const dimensions = readImageHeaderDimensions(pixels);
      if (!dimensions) {
        logger.warn("iOS rotate display probe could not read screenshot dimensions");
      }
      return dimensions ?? undefined;
    } catch (error) {
      logger.warn(`iOS rotate display probe failed: ${errorMessage(error)}`, error);
      return undefined;
    }
  }
}

interface IosRotationDisplayRead {
  requested: "portrait" | "landscape";
  previousObservation: ObserveResult | undefined;
  device: BootedDevice;
  probe: IosDisplayPixelProbe | undefined;
  timer: Timer;
  signal?: AbortSignal;
}

/** Re-read one contradictory frame after allowing the display animation to settle. */
export async function verifyIosRotationDisplayRead(
  verified: RotateResult,
  context: IosRotationDisplayRead,
): Promise<RotateResult> {
  const { requested, previousObservation, device, probe: injectedProbe, timer, signal } = context;
  if (!verified.success) {
    return verified;
  }
  const probe = injectedProbe ?? new SimulatorIosDisplayPixelProbe(device);
  const displayKey = verified.observation?.display.key ?? previousObservation?.display.key;
  const reconcile = (pixels: { width: number; height: number } | undefined) =>
    reconcileIosRotationWithDisplayRead(verified, requested, previousObservation, pixels);
  const first = reconcile(await probe.readPixelSize(device.deviceId, displayKey, signal));
  if (first.success) {
    return first;
  }
  await awaitWhileRequestIsLive(timer.sleep(200), signal);
  return reconcile(await probe.readPixelSize(device.deviceId, displayKey, signal));
}
