import type { BootedDevice } from "../../../models";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import {
  isAppleSystemBundleId,
  mergeDyldInsertLibraries,
  SIMCTL_CHILD_DYLD_INSERT_LIBRARIES,
} from "../../prototype/ios/prototypeAgentInjection";
import type { IosCameraPosterDylibProvider } from "./IosCameraPosterDylibProvider";
import type { IosCameraPosterRegistry } from "./IosCameraPosterRegistry";

export const SIMCTL_CHILD_AM_CAMERA_POSTER_PATH = "SIMCTL_CHILD_AM_CAMERA_POSTER_PATH";
export const SIMCTL_CHILD_AM_CAMERA_POSTER_QR = "SIMCTL_CHILD_AM_CAMERA_POSTER_QR";

export const CAMERA_POSTER_SYSTEM_APP_SKIPPED =
  "camera poster not applied: Apple system apps (com.apple.*) cannot be injected";

function registeredSimulatorPoster(device: BootedDevice, registry: IosCameraPosterRegistry) {
  return device.platform === "ios" && resolveIosDeviceKind(device) === "simulator"
    ? registry.get(device.deviceId)
    : undefined;
}

/** Why a registered poster is left out of this launch, or `undefined` when it is not skipped. */
export function cameraPosterLaunchSkip(
  device: BootedDevice,
  registry: IosCameraPosterRegistry,
  bundleId: string,
): string | undefined {
  return isAppleSystemBundleId(bundleId) && registeredSimulatorPoster(device, registry)
    ? CAMERA_POSTER_SYSTEM_APP_SKIPPED
    : undefined;
}

/**
 * Only registered simulator posters resolve a dylib, and never for an Apple system app (the
 * prototype injection guard), which launches unchanged. Prototype env entries take precedence
 * over the host.
 */
export async function prepareCameraPosterLaunch(
  device: BootedDevice,
  deps: {
    registry: IosCameraPosterRegistry;
    provider: IosCameraPosterDylibProvider;
    hostEnv: NodeJS.ProcessEnv;
  },
  launchEnvironment?: Record<string, string>,
  bundleId?: string,
): Promise<Record<string, string> | undefined> {
  const poster = registeredSimulatorPoster(device, deps.registry);
  if (!poster || (bundleId !== undefined && isAppleSystemBundleId(bundleId))) {
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
    // cropped at the edges, which breaks decoding. The other mode's variable is set empty so an
    // inherited host value cannot win: the library prefers any nonempty image path over a QR.
    ...(poster.kind === "qr"
      ? {
          [SIMCTL_CHILD_AM_CAMERA_POSTER_QR]: poster.text,
          [SIMCTL_CHILD_AM_CAMERA_POSTER_PATH]: "",
        }
      : {
          [SIMCTL_CHILD_AM_CAMERA_POSTER_PATH]: poster.path,
          [SIMCTL_CHILD_AM_CAMERA_POSTER_QR]: "",
        }),
  };
}
