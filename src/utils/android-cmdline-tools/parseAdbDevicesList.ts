import { withAndroidTransportId } from "../androidSerial";
import type { AdbDeviceState } from "./interfaces/AdbExecutor";

const TRANSPORT_ID_PREFIX = "transport_id:";

/**
 * Parse `adb devices -l` stdout into raw device rows (every state, not only
 * online devices). The first line is the "List of devices attached" header.
 * A `transport_id:` field is kept as private connection metadata.
 */
export function parseAdbDevicesList(stdout: string): AdbDeviceState[] {
  return stdout
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const fields = line.trim().split(/\s+/);
      const [deviceId, state] = fields;
      const transportId = fields
        .find((field) => field.startsWith(TRANSPORT_ID_PREFIX))
        ?.slice(TRANSPORT_ID_PREFIX.length);
      return deviceId && state ? [withAndroidTransportId({ deviceId, state }, transportId)] : [];
    });
}
