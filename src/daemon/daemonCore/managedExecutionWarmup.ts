import { IosCtrlProxyBuilder } from "../../ctrlProxy/IosCtrlProxyBuilder";
import { initializeIosCtrlProxyAtStartup, selectIosStartupWarmupDevices } from "../iosStartupInit";
import type { DaemonBrokerHost } from "./DaemonBroker";

// Keep expiry-sensitive reads live so instance replacements and lazy expiry remain observable.
export async function warmConfirmedManagedExecution(
  host: Pick<DaemonBrokerHost, "services" | "lifecycle">,
  sessionUuid: string,
): Promise<void> {
  const session = host.services.sessionManager().getSession(sessionUuid);
  if (
    host.lifecycle.shutdownInProgress() ||
    !session ||
    !host.services.sessionManager().isLiveManagedExecutionSession(sessionUuid)
  ) {
    return;
  }
  const deviceId = session.assignedDevice;
  const devices = selectIosStartupWarmupDevices(
    [{ id: deviceId, platform: session.platform }],
    host.services.passiveWorkPolicy(),
  );
  if (
    devices.length === 0 ||
    host.services.sessionManager().getSessionForDevice(deviceId) !== sessionUuid
  ) {
    return;
  }
  await initializeIosCtrlProxyAtStartup([deviceId], {
    timer: host.services.timer(),
    perDeviceTimeoutMs: 5000,
    pendingPrefetch: () => IosCtrlProxyBuilder.pendingPrefetch(),
    isShuttingDown: () => host.lifecycle.shutdownInProgress(),
    verifyIosDevice: async (id, options) => {
      if (
        !host.lifecycle.shutdownInProgress() &&
        host.services.sessionManager().isLiveManagedExecutionSession(sessionUuid) &&
        host.services.sessionManager().getSession(sessionUuid)?.assignedDevice === id &&
        host.services.sessionManager().getSessionForDevice(id) === sessionUuid &&
        host.lifecycle.managedExecutionReowner()?.ownershipState(sessionUuid) === undefined
      ) {
        await host.services.iosDeviceVerifier()().verifyIosDevice(id, options);
      }
    },
  });
}
