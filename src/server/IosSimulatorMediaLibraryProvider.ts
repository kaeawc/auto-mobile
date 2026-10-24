import type { DeviceServicePreflight } from "../utils/deviceServicePreflight";
import {
  type AppFileFileSystem,
  type AppFileWriteProvider,
  type PutAppFileProviderRequest,
} from "./appFileService";
import { type IosSimulatorMediaClient } from "./iosSimulatorMediaClient";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { ActionableError } from "../models";
import { hasSupportedSimulatorMediaExtension } from "./appFileContract";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

export class IosSimulatorMediaLibraryProvider implements AppFileWriteProvider {
  readonly platform = "ios" as const;
  readonly domain = "media_library" as const;

  constructor(
    private readonly mediaClient: IosSimulatorMediaClient,
    private readonly fileSystem: AppFileFileSystem,
    private readonly servicePreflight: DeviceServicePreflight = { assertEnabled: async () => {} },
  ) {}

  async putFile(request: PutAppFileProviderRequest) {
    return (await this.putFiles([request]))[0];
  }

  async putFiles(requests: PutAppFileProviderRequest[]) {
    if (requests.length === 0) {
      return [];
    }
    const request = requests[0]!;
    if (resolveIosDeviceKind({ deviceId: request.device.deviceId }) !== "simulator") {
      throw new ActionableError(
        `iOS media-library staging is only supported on iOS simulators. Device ${request.device.deviceId} looks like a physical iOS device.`,
      );
    }
    await this.servicePreflight.assertEnabled(request.device, "putAppFile", request.signal);
    for (const file of requests) {
      if (!hasSupportedSimulatorMediaExtension(file.destinationPath)) {
        throw new ActionableError(
          `iOS Simulator media fixture requires a supported image or video extension: ${file.destinationPath}`,
        );
      }
    }
    const directory = await this.fileSystem.mkdtemp(join(tmpdir(), "automobile-ios-media-"));
    try {
      const paths = await Promise.all(
        requests.map(async (file, index) => {
          // Keep the requested filename for media-type inference while isolating
          // duplicate basenames from separate destination directories.
          const path = join(directory, String(index), basename(file.destinationPath));
          await this.fileSystem.mkdir(dirname(path));
          await this.fileSystem.copyFile(file.sourcePath, path);
          return path;
        }),
      );
      await this.mediaClient.importMedia(request.device, paths, request.signal);
      return requests.map(() => ({
        effects: [
          {
            type: "media_import",
            status: "completed" as const,
            reason: "Imported into the iOS Simulator media library through simctl addmedia.",
          },
          {
            type: "picker_visibility",
            status: "unavailable" as const,
            reason: "Picker visibility is not verified by simctl addmedia.",
          },
        ],
      }));
    } finally {
      await this.fileSystem.rm(directory);
    }
  }
}
