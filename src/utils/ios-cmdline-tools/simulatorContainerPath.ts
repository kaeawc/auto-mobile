import { posix } from "node:path";
import { IOS_SIMULATOR_UUID_PATTERN } from "./iosDeviceType";

/** Parse only an exact application data container inside the configured device set. */
export function parseSimulatorContainerPath(
  path: string,
  deviceSetRoot: string,
): { udid: string; containerUuid: string } | null {
  return parseContainerPath(path, deviceSetRoot, "data/Containers/Data/Application");
}

/** Parse only an exact shared App Group container inside the configured device set. */
export function parseSimulatorGroupContainerPath(
  path: string,
  deviceSetRoot: string,
): { udid: string; containerUuid: string } | null {
  return parseContainerPath(path, deviceSetRoot, "data/Containers/Shared/AppGroup");
}

function parseContainerPath(
  path: string,
  deviceSetRoot: string,
  containerDirectory: string,
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
    segments.slice(1, 5).join("/") !== containerDirectory ||
    !IOS_SIMULATOR_UUID_PATTERN.test(udid) ||
    !IOS_SIMULATOR_UUID_PATTERN.test(containerUuid)
  ) {
    return null;
  }
  return { udid, containerUuid };
}
