import type { DevicePool } from "../../src/daemon/devicePool";
import type { Platform } from "../../src/models";

/**
 * Hold a pooled device the way a running multi-device plan's label session does:
 * the session is created by a multi-device allocation, so its device frees when
 * the plan ends. Other multi-device requests keep waiting for it, whereas a
 * session bound directly (as `getAndroid` does) holds its device until released
 * and makes such a request fail fast (#9950). The device is picked by name.
 */
export const holdAsPlanSession = (
  pool: DevicePool,
  sessionId: string,
  deviceName: string,
  platform: Platform = "android",
): Promise<Map<string, string>> =>
  pool.assignMultipleDevicesByCriteria(
    [{ sessionId, criteria: { platform, simulatorType: deviceName } }],
    1_000,
  );
