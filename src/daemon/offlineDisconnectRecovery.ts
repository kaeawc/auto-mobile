import type { MultiPlatformDeviceManager } from "../devices/deviceUtils";
import type { discoverAndReconcile, probeListedAndroidStates } from "./deviceLossDiscovery";
import { logger } from "../utils/logger";

type Discovery = Awaited<ReturnType<typeof discoverAndReconcile>>;

interface OfflineDisconnectRecoveryOptions {
  deviceManager: Pick<MultiPlatformDeviceManager, "recoverAndroidOfflineDevices">;
  planActive: boolean;
  listed: Awaited<ReturnType<typeof probeListedAndroidStates>>;
  discovery: Discovery;
  prepareRecovery: () => { dispatchTargets: string[] };
  rediscover: () => Promise<Discovery>;
}

/** Reconnect each offline episode once, then replace stale pre-recovery absence evidence. */
export async function recoverOfflineDisconnectCandidates({
  deviceManager,
  planActive,
  listed,
  discovery,
  prepareRecovery,
  rediscover,
}: OfflineDisconnectRecoveryOptions): Promise<Discovery> {
  if (planActive) {
    return discovery;
  }
  const { dispatchTargets } = prepareRecovery();
  if (dispatchTargets.length === 0) {
    return discovery;
  }

  logger.warn(
    `[DisconnectMonitor] In-session device(s) ADB-offline (${dispatchTargets.join(", ")}); attempting bounded 'adb -s <serial> reconnect' recovery before miss-counting`,
  );
  // Serial-scoped reconnects for the dispatch targets, one
  // shot per offline episode; failures are logged and swallowed
  // inside recoverAndroidOfflineDevices so a probe or recovery
  // hiccup here never blocks the miss-count/disconnect path below.
  const offlineTransportIds = dispatchTargets.flatMap((deviceId) => {
    const transports = listed.offlineTransportIds?.get(deviceId);
    return transports?.size ? [...transports] : [deviceId];
  });
  await deviceManager.recoverAndroidOfflineDevices(offlineTransportIds);
  // Reconnect may restore the transport during this await. Never use
  // the pre-recovery absence for miss counting or ADB-reset detection.
  return rediscover();
}
