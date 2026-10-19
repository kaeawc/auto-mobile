import { type AppFileWriteProvider, type PutAppFileProviderRequest } from "./appFileService";
import { getSharedStorageService, type SharedStorageService } from "./sharedStorageService";
import { ActionableError } from "../models";
import { hasSupportedMediaLibraryExtension } from "./appFileContract";

const ANDROID_MEDIA_LIBRARY_NAMESPACE = "automobile-media";

export class AndroidMediaLibraryProvider implements AppFileWriteProvider {
  readonly platform = "android" as const;
  readonly domain = "media_library" as const;
  readonly features = { mediaIndexing: true } as const;

  // Resolve the shared service only for a write; metadata queries remain pure.
  constructor(private readonly sharedStorageService?: SharedStorageService) {}

  async putFile(request: PutAppFileProviderRequest) {
    return (await this.putFiles([request]))[0];
  }

  async putFiles(requests: PutAppFileProviderRequest[]) {
    if (requests.length === 0) {
      return [];
    }
    const request = requests[0]!;
    if (request.target.domain !== "media_library") {
      throw new ActionableError(
        `Android media-library provider received unsupported target domain: ${request.target.domain}`,
      );
    }
    for (const file of requests) {
      if (file.target.domain !== "media_library") {
        throw new ActionableError(
          `Android media-library provider received unsupported target domain: ${file.target.domain}`,
        );
      }
      if (!hasSupportedMediaLibraryExtension(file.destinationPath)) {
        throw new ActionableError(
          `Android media-library fixture ${file.destinationPath} must use an image, video, or audio filename supported by Android MediaStore.`,
        );
      }
    }
    const result = await (this.sharedStorageService ?? getSharedStorageService()).stage({
      device: request.device,
      ...(request.userId === undefined ? {} : { explicitUserId: request.userId }),
      namespace: ANDROID_MEDIA_LIBRARY_NAMESPACE,
      files: requests.map((file) => ({
        sourcePath: file.sourcePath,
        destinationPath: file.destinationPath,
      })),
      signal: request.signal,
      rollbackOnFailure: true,
      requireMediaIndexing: true,
    });
    return result.files.map((staged) => {
      if (staged.mediaIndexing.status !== "completed") {
        throw new ActionableError(
          `Android media-library fixture ${staged.destinationPath} on device ${result.deviceId}, ` +
            `resolved profile ${result.userId}, was not indexed. ` +
            "Recovery: use an image, video, or audio filename supported by Android MediaStore.",
        );
      }
      return {
        effects: [
          {
            type: "media_index",
            status: "completed" as const,
            reason:
              `MediaStore verified fixture discovery for device ${result.deviceId}, ` +
              `resolved profile ${result.userId}, namespace ${result.namespace}`,
          },
        ],
      };
    });
  }
}
