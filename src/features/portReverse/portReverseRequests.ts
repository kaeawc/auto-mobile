import type { AdbReverseEntry } from "../../utils/android-cmdline-tools/adbReverse";
import { PortReverseError } from "./PortReverseError";
import type {
  PortReverseMapping,
  PortReverseRequest,
  PortReverseStatus,
} from "./PortReverseManager";

/** Request helpers for {@link PortReverseManager}: one mapping shape and one request per port. */

const tcp = (port: number) => `tcp:${port}`;

export function entryFor(request: PortReverseRequest): AdbReverseEntry {
  return {
    devicePort: request.devicePort,
    host: tcp(request.hostPort),
    hostPort: request.hostPort,
  };
}

export function ownedMapping(
  request: PortReverseRequest,
  status: PortReverseStatus,
): PortReverseMapping {
  return { ...entryFor(request), owned: true, status };
}

/** One request per device port; two different host ports for one device port is a conflict. */
export function uniqueRequests(requests: readonly PortReverseRequest[]): PortReverseRequest[] {
  const byPort = new Map<number, PortReverseRequest>();
  for (const request of requests) {
    const earlier = byPort.get(request.devicePort);
    if (earlier !== undefined && earlier.hostPort !== request.hostPort) {
      throw new PortReverseError(
        "port_reverse_conflict",
        `${tcp(request.devicePort)} was requested for both ${tcp(earlier.hostPort)} and ${tcp(request.hostPort)}.`,
        [request.devicePort],
      );
    }
    byPort.set(request.devicePort, request);
  }
  return [...byPort.values()];
}
