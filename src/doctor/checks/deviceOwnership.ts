import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { DeviceOwnershipView } from "../../daemon/deviceOwnershipView";
import type { CheckResult } from "../types";

const CHECK_NAME = "Device Ownership Agreement";

export interface DeviceOwnershipCheckDependencies {
  view: Pick<DeviceOwnershipView, "snapshot">;
}

/** Report devices whose ownership stores disagree. Report-only; changes nothing. */
export async function checkDeviceOwnership(
  dependencies: DeviceOwnershipCheckDependencies,
): Promise<CheckResult> {
  try {
    const contested = (await dependencies.view.snapshot()).filter(
      (device) => device.disagreements.length > 0,
    );
    if (contested.length === 0) {
      return { name: CHECK_NAME, status: "pass", message: "Device ownership stores agree" };
    }
    return {
      name: CHECK_NAME,
      status: "warn",
      message: `${contested.length} device(s) have ownership records that disagree`,
      value: contested.length,
      detail: contested
        .flatMap((device) =>
          device.disagreements.map(
            (d) => `- ${device.platform} ${device.deviceId}: ${d.kind}: ${d.detail}`,
          ),
        )
        .join("\n"),
      recommendation:
        "Stop the daemon named by each live PID, or release the device from the session " +
        "that should own it; records for processes that are gone are reclaimed automatically.",
    };
  } catch (error) {
    logger.warn(`Device ownership check failed: ${errorMessage(error)}`, error);
    return {
      name: CHECK_NAME,
      status: "warn",
      message: `Could not read device ownership: ${errorMessage(error)}`,
    };
  }
}
