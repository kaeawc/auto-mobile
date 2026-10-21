import type { BootedDevice } from "../../../models";
import type { CtrlProxyLocationRequest, CtrlProxyLocationResult } from "../../observe/ios/types";

/** The CtrlProxy runner's `request_location` (`XCUIDevice.location`), used on physical iOS. */
export interface IosRunnerLocationClient {
  requestLocation(
    request: CtrlProxyLocationRequest,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<CtrlProxyLocationResult>;
}

/** How a composition root hands the runner to the location tool (#11806: no `getInstance` here). */
export type IosRunnerLocationResolver = (device: BootedDevice) => IosRunnerLocationClient;

const IOS_RUNNER_LOCATION_UNSUPPORTED =
  "Location simulation on a physical iOS device needs a CtrlProxy runner that supports " +
  "request_location (XCUIDevice.location, iOS 16.4+ with Xcode 14.3+). Reinstall the runner and retry.";

/** Throw on a refused runner fix so playback and the static path share one failure shape. */
export async function sendRunnerLocation(
  runner: IosRunnerLocationClient,
  request: CtrlProxyLocationRequest,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const result = await runner.requestLocation(request, options.timeoutMs, options.signal);
  if (!result.success) {
    throw new IosRunnerLocationError(result);
  }
}

export class IosRunnerLocationError extends Error {
  readonly unsupported: boolean;
  constructor(result: CtrlProxyLocationResult, message?: string) {
    super(
      message ??
        (result.unsupported
          ? IOS_RUNNER_LOCATION_UNSUPPORTED
          : (result.error ?? "runner refused the fix")),
    );
    this.unsupported = result.unsupported === true;
  }
}
