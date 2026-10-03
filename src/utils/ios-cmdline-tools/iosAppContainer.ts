import type { SimCtlClient } from "./SimCtlClient";
import { resolveIosLenientTerminateBackend } from "./IosDeviceBackend";

export { IOS_APP_DATA_FOLDERS, getAppDataContainerPath } from "./iosAppContainerData";

/** Preserve the legacy simulator-only, non-fatal termination helper. */
export function terminateAppIfRunning(
  simctl: Pick<SimCtlClient, "terminateApp">,
  deviceId: string,
  bundleId: string,
): Promise<void> {
  return resolveIosLenientTerminateBackend(deviceId, { simctl }).terminateApp(bundleId);
}
