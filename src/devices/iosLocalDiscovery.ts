import { combineWithAmbientAbort } from "../utils/AbortContext";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { DeviceManagerSimCtl } from "./deviceDiscoveryContracts";

/** True on macOS, else whether `xcrun simctl` is reachable; aborts propagate. */
export async function canDiscoverIosLocally(
  simctl: Pick<DeviceManagerSimCtl, "isAvailable">,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const discoverySignal = combineWithAmbientAbort(signal);
  discoverySignal?.throwIfAborted();
  if (platform === "darwin") {
    return true;
  }
  try {
    const available = await simctl.isAvailable({ signal: discoverySignal });
    discoverySignal?.throwIfAborted();
    return available;
  } catch (error) {
    discoverySignal?.throwIfAborted();
    // simctl.isAvailable() throws on non-macOS hosts/missing Xcode tools; treat as "no local iOS discovery".
    logger.debug(`iOS local discovery probe failed: ${errorMessage(error)}`, error);
    return false;
  }
}
