import { type AppFileWriteProvider, type PutAppFileProviderRequest } from "./appFileService";
import { getSharedStorageService, type SharedStorageService } from "./sharedStorageService";
import { ActionableError } from "../models";

export class AndroidUserFilesProvider implements AppFileWriteProvider {
  readonly platform = "android" as const;
  readonly domain = "user_files" as const;
  readonly features = { namespaceReset: true, mediaIndexing: true } as const;

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
    if (request.target.domain !== "user_files") {
      throw new ActionableError(
        `Android user-files provider received unsupported target domain: ${request.target.domain}`,
      );
    }
    const result = await (this.sharedStorageService ?? getSharedStorageService()).stage({
      device: request.device,
      ...(request.userId === undefined ? {} : { explicitUserId: request.userId }),
      namespace: request.target.namespace,
      reset: request.target.reset,
      indexMedia: request.target.indexMedia ?? false,
      files: requests.map((file) => ({
        sourcePath: file.sourcePath,
        destinationPath: file.destinationPath,
      })),
      signal: request.signal,
      rollbackOnFailure: true,
    });
    return result.files.map((staged) => ({
      effects: [
        {
          type: "document_picker",
          status: "completed" as const,
          reason:
            `document fixture is available in Downloads for device ${result.deviceId}, ` +
            `resolved profile ${result.userId}, namespace ${result.namespace}`,
        },
        {
          type: "media_index",
          status: staged.mediaIndexing.status,
          ...(staged.mediaIndexing.reason === undefined
            ? {}
            : { reason: staged.mediaIndexing.reason }),
        },
      ],
    }));
  }
}
