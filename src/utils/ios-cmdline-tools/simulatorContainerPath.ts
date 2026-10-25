import { posix } from "node:path";
import { IOS_SIMULATOR_UUID_PATTERN } from "./iosDeviceType";

/** Parse only an exact application data container inside the configured device set. */
export function parseSimulatorContainerPath(
  path: string,
  deviceSetRoot: string,
): { udid: string; containerUuid: string } | null {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path) {
    return null;
  }
  const prefix = `${posix.normalize(deviceSetRoot).replace(/\/$/, "")}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }
  const segments = path.slice(prefix.length).split("/");
  const udid = segments[0] ?? "";
  const containerUuid = segments[5] ?? "";
  if (
    segments.length !== 6 ||
    segments.slice(1, 5).join("/") !== "data/Containers/Data/Application" ||
    !IOS_SIMULATOR_UUID_PATTERN.test(udid) ||
    !IOS_SIMULATOR_UUID_PATTERN.test(containerUuid)
  ) {
    return null;
  }
  return { udid, containerUuid };
}
