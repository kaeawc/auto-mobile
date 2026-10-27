import { ObserverSessionRegistry } from "../observerSessionRegistry";
import { ObserverReleaseBroadcaster } from "../observerReleaseBroadcast";
import { clearSessionAppearanceConfig } from "../appearanceManager";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { parseDeviceRecoveryPolicy } from "../poolConfig";

/** Observer release drops both its appearance config and the viewer streams it admitted. */
export function createDaemonObserverSessionRegistry(timer: Timer): ObserverSessionRegistry {
  return new ObserverSessionRegistry(timer, undefined, (sessionId) => {
    // An observer's per-session appearance config (#10976) dies with the observer.
    clearSessionAppearanceConfig(sessionId).catch((error: unknown) => {
      logger.warn(`[Appearance] Failed to drop config of observer ${sessionId}`, error);
    });
    // So do the viewer streams its registration admitted (#11076).
    ObserverReleaseBroadcaster.emit(sessionId);
  });
}

export function daemonDeviceRecoveryConfiguration(environment: NodeJS.ProcessEnv) {
  const recoveryConfiguration = parseDeviceRecoveryPolicy(environment);
  for (const warning of recoveryConfiguration.warnings) {
    logger.warn(`[Daemon] ${warning}`);
  }
  logger.info(
    `[Daemon] Device recovery policy: onLoss=${recoveryConfiguration.policy.onLoss}, ` +
      `maxAttempts=${recoveryConfiguration.policy.maxAttempts}`,
  );
  return recoveryConfiguration;
}
