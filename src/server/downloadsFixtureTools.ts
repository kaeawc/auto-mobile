import { ToolRegistry, type ProgressCallback } from "./toolRegistry";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ActionableError } from "../models";
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
  // Registered through the DEVICE-AWARE path (like the session-log family's
  // `resetAppLogs`, #7006) for one reason: the MCP boundary only runs the #6069
  // cross-session ownership guard for `requiresDevice` tools. A plain tool that
  // self-resolves the session device would let a connection bound to session A
  // submit another live session B's UUID and, with `reset: true`, delete or
  // overwrite B's Downloads fixtures — the guard never ran. Marking the tool
  // device-aware makes that guard reject a foreign `sessionUuid` at the boundary,
  // before any device is touched.
  //
  // Device resolution itself stays in the service (session binding, the typed
  // SESSION_NOT_BOUND/SESSION_NOT_ACTIVE refusals, and the iOS-unavailable
  // result), so `shouldEnsureDevice` is always false and the work runs in the
  // nonDeviceHandler; the deviceAwareHandler below is never invoked.
  ToolRegistry.registerDeviceAware(
    "stageSessionDownloads",
    "Stage host-file, UTF-8, or base64 fixtures into one bounded child directory of the " +
      "shared Downloads tree on the device owned by the caller's session, optionally resetting " +
      "that directory first and requesting Android media indexing (Android only).",
    stageSessionDownloadsSchema,
    async () => {
      throw new ActionableError(
        "stageSessionDownloads resolves its device from the caller's session, not the " +
          "device-aware pipeline.",
      );
    },
    {
      defaultEnabled: false,
      shouldEnsureDevice: () => false,
      nonDeviceHandler: async (
        args: StageSessionDownloadsArgs,
        _progress?: ProgressCallback,
        signal?: AbortSignal,
      ) =>
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
    },
  );
}
