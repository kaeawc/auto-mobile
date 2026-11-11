import { ActionableError, type BootedDevice } from "../../../models";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { FileQrPosterWriter, type QrPosterWriter } from "../../../utils/qr/QrPosterWriter";
import type { DeviceToolsDependencies } from "../../deviceLifecycle/core/dependencies";
import { mergeLegacyStartDevicePayload } from "../../deviceLifecycle/core/schemas";
import type { StartDeviceArgs } from "../../deviceLifecycle/core/contracts";
import { writeIosCameraPoster, IOS_CAMERA_POSTER_UNSUPPORTED } from "./IosCameraPoster";

export async function recordStartCameraPoster(
  args: StartDeviceArgs,
  device: BootedDevice,
  deps: Pick<
    DeviceToolsDependencies,
    "iosCameraPosterRegistry" | "cameraPosterQrWriter" | "cameraPosterFileExists"
  >,
): Promise<void> {
  if (
    device.platform === "ios" &&
    (args.cameraPosterPath !== undefined || args.cameraPosterQr !== undefined)
  ) {
    const poster = await writeIosCameraPoster(
      device,
      args.cameraPosterQr !== undefined
        ? { mode: "qr", text: args.cameraPosterQr.text }
        : { mode: "image", path: args.cameraPosterPath! },
      {
        registry: deps.iosCameraPosterRegistry,
        qrWriter: deps.cameraPosterQrWriter,
        fileExists: deps.cameraPosterFileExists,
      },
    );
    if (poster.error) {
      throw new ActionableError(poster.error);
    }
  }
}

export function validateCameraPosterPlatform(input: unknown): void {
  const merged = mergeLegacyStartDevicePayload(input);
  if (!merged || typeof merged !== "object") {
    return;
  }
  const args = merged as Record<string, unknown>;
  if (args.cameraPosterPath === undefined && args.cameraPosterQr === undefined) {
    return;
  }
  if (args.platform !== "android" && args.platform !== "ios") {
    throw new ActionableError(
      "cameraPoster requires an Android emulator or an iOS Simulator. Select platform ios or android.",
    );
  }
  if (
    args.platform === "ios" &&
    typeof args.deviceId === "string" &&
    resolveIosDeviceKind({ deviceId: args.deviceId }) !== "simulator"
  ) {
    throw new ActionableError(IOS_CAMERA_POSTER_UNSUPPORTED);
  }
}

/** Replace `cameraPosterQr` with the rendered poster's `cameraPosterPath`. */
export async function resolveCameraPosterQr<T extends StartDeviceArgs>(
  args: T,
  qrWriter?: QrPosterWriter,
): Promise<T> {
  const { cameraPosterQr, ...rest } = args;
  if (cameraPosterQr === undefined || args.platform === "ios") {
    return args;
  }
  const writer = qrWriter ?? new FileQrPosterWriter();
  return { ...rest, cameraPosterPath: await writer.writePoster(cameraPosterQr.text) } as T;
}
