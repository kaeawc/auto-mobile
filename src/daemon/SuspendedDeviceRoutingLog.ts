import { logger } from "../utils/logger";
import { type DeviceSessionResolver } from "./deviceSessionResolver";

/**
 * Per-server memo that keeps a suspended serial's drop notice to ONCE per
 * quarantine instead of once per dropped frame — passive streams push
 * continuously, so the per-frame form would bury the log it belongs in.
 */
export class SuspendedDeviceRoutingLog {
  private readonly announced = new Set<string>();

  /**
   * Whether frames attributed to `deviceId` must be dropped. Logs the first drop
   * of a quarantine and re-arms as soon as routing resumes, so a later
   * re-quarantine of the same serial is announced again.
   */
  shouldDropFrame(resolver: DeviceSessionResolver, deviceId: string, serverLabel: string): boolean {
    if (!resolver.isRoutingSuspended(deviceId)) {
      this.announced.delete(deviceId);
      return false;
    }
    if (!this.announced.has(deviceId)) {
      this.announced.add(deviceId);
      logger.debug(
        `[${serverLabel}] Dropping frames for ${deviceId}: its pooled AVD identity is ` +
          "unresolved, so there is no routing identity to attribute them to",
      );
    }
    return true;
  }
}
