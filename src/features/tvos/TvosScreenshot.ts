import type { BootedDevice } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { tvosRunners, type TvosRunnerRegistry } from "./TvosRunnerRegistry";

/** Captures an Apple TV simulator's screen as PNG bytes. */
export type TvosScreenshotCapture = (device: BootedDevice, signal?: AbortSignal) => Promise<Buffer>;

/** Through the connected tvOS runner. */
export async function captureTvosRunnerScreenshot(
  device: BootedDevice,
  signal?: AbortSignal,
  runners: Pick<TvosRunnerRegistry, "require"> = tvosRunners,
): Promise<Buffer> {
  const data = await runners
    .require(device.deviceId)
    .request({ type: "request_screenshot" }, signal);
  if (typeof data !== "string") {
    throw new ActionableError("Invalid tvOS screenshot; reconnect the runner.");
  }
  return Buffer.from(data, "base64");
}

/** Through `simctl io screenshot`, on simctl's default (only) display. */
export const captureTvosSimctlScreenshot: TvosScreenshotCapture = (device, signal) =>
  new SimCtlClient(device).screenshot(device.deviceId, undefined, signal);

/** The runner's screenshot when one is connected, otherwise simctl's. */
export function captureTvosScreenshot(
  device: BootedDevice,
  signal?: AbortSignal,
  runners: Pick<TvosRunnerRegistry, "get" | "require"> = tvosRunners,
  simctl: TvosScreenshotCapture = captureTvosSimctlScreenshot,
): Promise<Buffer> {
  return runners.get(device.deviceId)
    ? captureTvosRunnerScreenshot(device, signal, runners)
    : simctl(device, signal);
}
