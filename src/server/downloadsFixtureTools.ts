import { ToolRegistry, type ProgressCallback } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import {
  stageSessionDownloadsSchema,
  type StageSessionDownloadsArgs,
} from "./downloadsFixtureContract";
import {
  getDownloadsFixtureService,
  type DownloadsFixtureService,
} from "./downloadsFixtureService";

export function registerDownloadsFixtureTools(
  service: () => DownloadsFixtureService = getDownloadsFixtureService,
): void {
  ToolRegistry.register(
    "stageSessionDownloads",
    "Stage host-file, UTF-8, or base64 fixtures into one bounded child directory of the " +
      "shared Downloads tree on the device owned by the caller's session, optionally resetting " +
      "that directory first and requesting Android media indexing (Android only).",
    stageSessionDownloadsSchema,
    async (args: StageSessionDownloadsArgs, _progress?: ProgressCallback, signal?: AbortSignal) =>
      createJSONToolResponse(
        await service().stage({
          sessionUuid: args.sessionUuid,
          directory: args.directory,
          reset: args.reset,
          indexMedia: args.indexMedia,
          files: args.files,
          signal,
        }),
      ),
    { defaultEnabled: false },
  );
}
