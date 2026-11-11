import type { BootedDevice } from "../../../models";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import {
  mergeDyldInsertLibraries,
  SIMCTL_CHILD_DYLD_INSERT_LIBRARIES,
} from "../../prototype/ios/prototypeAgentInjection";
import type { IosCameraPosterDylibProvider } from "./IosCameraPosterDylibProvider";
import type { IosCameraPosterRegistry } from "./IosCameraPosterRegistry";

export const SIMCTL_CHILD_AM_CAMERA_POSTER_PATH = "SIMCTL_CHILD_AM_CAMERA_POSTER_PATH";
export const SIMCTL_CHILD_AM_CAMERA_POSTER_QR = "SIMCTL_CHILD_AM_CAMERA_POSTER_QR";

/** Only registered simulator posters resolve a dylib. Prototype env entries take precedence over the host. */
export async function prepareCameraPosterLaunch(
  device: BootedDevice,
  deps: {
    registry: IosCameraPosterRegistry;
    provider: IosCameraPosterDylibProvider;
    hostEnv: NodeJS.ProcessEnv;
  },
  launchEnvironment?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  if (device.platform !== "ios" || resolveIosDeviceKind(device) !== "simulator") {
    return undefined;
  }
  const poster = deps.registry.get(device.deviceId);
  if (!poster) {
    return undefined;
  }
  const dylib = await deps.provider.ensure();
  return {
    ...launchEnvironment,
    [SIMCTL_CHILD_DYLD_INSERT_LIBRARIES]: mergeDyldInsertLibraries(
      launchEnvironment?.[SIMCTL_CHILD_DYLD_INSERT_LIBRARIES] ??
        deps.hostEnv[SIMCTL_CHILD_DYLD_INSERT_LIBRARIES],
      dylib,
    ),
    // The library renders a QR itself with a quiet zone; a host PNG would be aspect-filled and
    // cropped at the edges, which breaks decoding.
    ...(poster.kind === "qr"
      ? { [SIMCTL_CHILD_AM_CAMERA_POSTER_QR]: poster.text }
      : { [SIMCTL_CHILD_AM_CAMERA_POSTER_PATH]: poster.path }),
  };
}
