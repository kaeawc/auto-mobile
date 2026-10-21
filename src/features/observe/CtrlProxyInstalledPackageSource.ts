import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { errorMessage } from "../../utils/describeUnknownError";
import { BootedDevice } from "../../models";
import { defaultTimer } from "../../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "./android";
import type { A11yInstalledPackagesResult } from "./android/types";
import type {
  AndroidInstalledPackageSource,
  AndroidInstalledPackagesRequest,
  AndroidPackagesA11yClient,
} from "./ListInstalledApps";

/** Production source: one request against the on-device accessibility service. */
export class CtrlProxyInstalledPackageSource implements AndroidInstalledPackageSource {
  private readonly device: BootedDevice;
  private readonly a11yClient?: AndroidPackagesA11yClient;

  constructor(device: BootedDevice, a11yClient?: AndroidPackagesA11yClient) {
    this.device = device;
    this.a11yClient = a11yClient;
  }

  private async requestFromClient(
    client: AndroidPackagesA11yClient,
    signal?: AbortSignal,
  ): Promise<A11yInstalledPackagesResult> {
    signal?.throwIfAborted();
    if (!signal) {
      return client.requestInstalledPackages(true, undefined, 4000);
    }

    const request = client.requestInstalledPackages(true, undefined, 4000);
    void request.then(
      () => {
        if (signal.aborted) {
          // The request settled after cancellation won the race, so its result is safe to ignore.
          logger.debug(
            `[ListInstalledApps] ignoring late installed_packages response for device ${this.device.deviceId}`,
          );
        }
      },
      (error) => {
        if (signal.aborted) {
          // The request settled after cancellation won the race, so its failure is safe to ignore.
          logger.debug(
            `[ListInstalledApps] ignoring late installed_packages failure for device ${this.device.deviceId}: ${errorMessage(error)}`,
          );
        }
      },
    );
    return await raceWithDeadline(request, {
      timer: defaultTimer,
      signal,
      label: "Installed packages request",
      relabelDefaultAbort: false,
    });
  }

  async requestInstalledPackages(signal?: AbortSignal): Promise<AndroidInstalledPackagesRequest> {
    try {
      const client = this.a11yClient ?? AndroidCtrlProxyClient.getInstance(this.device);
      const result = await this.requestFromClient(client, signal);
      signal?.throwIfAborted();
      if (result.success) {
        return { available: true, result: { userId: result.userId, packages: result.packages } };
      }
      const reason = result.error ?? "unknown error";
      // The caller folds this reason into one warn only when a non-namesOnly catalog fallback runs.
      logger.debug(
        `[ListInstalledApps] installed_packages request failed for device ${this.device.deviceId}: ${reason}`,
      );
      return { available: false, reason };
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? error;
      }
      const reason = errorMessage(error);
      // The caller folds this reason into one warn only when a non-namesOnly catalog fallback runs.
      logger.debug(
        `[ListInstalledApps] installed_packages request threw for device ${this.device.deviceId}: ${reason}`,
      );
      return { available: false, reason };
    }
  }
}
