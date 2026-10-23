import { StageSessionDownloadsRefusal } from "./StageSessionDownloadsRefusal";

import { defaultDaemonContext, type DaemonContext } from "../daemon/daemonContext";
import {
  resolveActiveSessionDevice,
  type ActiveSessionDevice,
  type ActiveSessionResolver,
} from "./activeSessionDevice";
import {
  getSharedStorageService,
  type SharedStorageService,
  type StageSharedStorageRequest,
} from "./sharedStorageService";
import type { SharedStorageFileInput } from "./sharedStorageContract";
import type { StageSessionDownloadsResult } from "./downloadsFixtureContract";
import { stageSessionDownloadsAsPutAppFile } from "./deviceMutationDataAdapters";
import { createRecording, type DeviceMutationRecording } from "./deviceMutationRecording";

export interface StageSessionDownloadsRequest {
  sessionUuid: string | undefined;
  directory: string;
  reset?: boolean;
  indexMedia?: boolean;
  files: SharedStorageFileInput[];
  signal?: AbortSignal;
}

export interface DownloadsFixtureService {
  stage(request: StageSessionDownloadsRequest): Promise<StageSessionDownloadsResult>;
}

export interface DownloadsFixtureServiceDependencies {
  resolveActiveSession?: ActiveSessionResolver;
  sharedStorage?: () => SharedStorageService;
  registerPendingDeviceCleanup?: (deviceId: string, cleanup: Promise<unknown>) => void;
  /** Journals the staged files before the first device write, as the device dispatcher does. */
  mutationRecording?: () => Pick<DeviceMutationRecording, "beforeToolCall">;
}

let downloadsFixtureService: DownloadsFixtureService | null = null;

export function getDownloadsFixtureService(): DownloadsFixtureService {
  if (!downloadsFixtureService) {
    downloadsFixtureService = createDownloadsFixtureService();
  }
  return downloadsFixtureService;
}

export function createDownloadsFixtureService(
  deps: DownloadsFixtureServiceDependencies = {},
): DownloadsFixtureService {
  let recording: DeviceMutationRecording | undefined;
  return new DefaultDownloadsFixtureService(
    deps.resolveActiveSession ?? resolveActiveSessionDevice,
    deps.sharedStorage ?? getSharedStorageService,
    deps.registerPendingDeviceCleanup ?? registerPendingDeviceCleanup,
    deps.mutationRecording ?? (() => (recording ??= createRecording(defaultDaemonContext))),
  );
}

export function registerPendingDeviceCleanup(
  deviceId: string,
  cleanup: Promise<unknown>,
  daemon: DaemonContext = defaultDaemonContext,
): void {
  daemon.sessionManager()?.registerPendingDeviceCleanup(deviceId, cleanup);
}

class DefaultDownloadsFixtureService implements DownloadsFixtureService {
  constructor(
    private readonly resolveActiveSession: ActiveSessionResolver,
    private readonly sharedStorage: () => SharedStorageService,
    private readonly registerPendingDeviceCleanup: (
      deviceId: string,
      cleanup: Promise<unknown>,
    ) => void,
    private readonly mutationRecording: () => Pick<DeviceMutationRecording, "beforeToolCall">,
  ) {}

  async stage(request: StageSessionDownloadsRequest): Promise<StageSessionDownloadsResult> {
    const sessionUuid = request.sessionUuid?.trim();
    // Session binding comes first, and before anything else: a caller without a
    // bound session, or one that no longer owns a device, is refused before any
    // device client is constructed.
    if (!sessionUuid) {
      throw new StageSessionDownloadsRefusal(
        "SESSION_NOT_BOUND",
        "stageSessionDownloads requires the caller's bound device session.",
      );
    }
    const active = this.resolveActiveSession(sessionUuid);
    if (!active) {
      throw new StageSessionDownloadsRefusal(
        "SESSION_NOT_ACTIVE",
        `No active device session found for sessionUuid ${sessionUuid}.`,
      );
    }

    if (active.device.platform !== "android") {
      return {
        success: false,
        sessionUuid,
        deviceId: active.device.deviceId,
        platform: "ios",
        status: "unavailable",
        reason:
          "Shared Downloads staging is only available on Android; iOS has no user-visible " +
          "shared Downloads tree.",
      };
    }

    const stageRequest: StageSharedStorageRequest = {
      namespace: request.directory,
      reset: request.reset,
      indexMedia: request.indexMedia,
      files: request.files,
      device: active.device,
      signal: request.signal,
    };
    // Register before awaiting: if session release races cancellation, DevicePool
    // observes this promise and keeps the device assigned until all staging work
    // has settled. The journal row is part of that work: this tool resolves its device here,
    // so the device dispatcher never records it.
    const stagedPromise = this.recordThenStage(request, sessionUuid, active, stageRequest);
    this.registerPendingDeviceCleanup(active.device.deviceId, stagedPromise);
    const staged = await stagedPromise;
    return {
      success: true,
      sessionUuid,
      deviceId: staged.deviceId,
      platform: "android",
      directory: staged.namespace,
      userId: staged.userId,
      userSource: staged.userSource,
      destinationDirectory: staged.destinationDirectory,
      reset: staged.reset,
      files: staged.files,
    };
  }

  private async recordThenStage(
    request: StageSessionDownloadsRequest,
    sessionUuid: string,
    active: ActiveSessionDevice,
    stageRequest: StageSharedStorageRequest,
  ) {
    await this.mutationRecording().beforeToolCall(
      "putAppFile",
      stageSessionDownloadsAsPutAppFile(request),
      active.device,
      sessionUuid,
      request.signal,
    );
    return this.sharedStorage().stage(stageRequest);
  }
}
