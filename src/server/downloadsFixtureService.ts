import { ActionableError } from "../models";
import { DaemonState } from "../daemon/daemonState";
import { resolveActiveSessionDevice, type ActiveSessionResolver } from "./activeSessionDevice";
import {
  getSharedStorageService,
  type SharedStorageService,
  type StageSharedStorageRequest,
} from "./sharedStorageService";
import type { SharedStorageFileInput } from "./sharedStorageContract";
import type {
  StageSessionDownloadsRefusalCode,
  StageSessionDownloadsResult,
} from "./downloadsFixtureContract";

/**
 * Refuses a session-scoped Downloads-staging request before any device access.
 * Carries the same code vocabulary as the session-log resource family so a
 * caller that does not own a live session learns nothing about the device and
 * no device client is ever constructed on refusal.
 */
export class StageSessionDownloadsRefusal extends ActionableError {
  constructor(
    readonly code: StageSessionDownloadsRefusalCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "StageSessionDownloadsRefusal";
  }
}

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
}

let downloadsFixtureService: DownloadsFixtureService | null = null;

export function getDownloadsFixtureService(): DownloadsFixtureService {
  if (!downloadsFixtureService) {
    downloadsFixtureService = createDownloadsFixtureService();
  }
  return downloadsFixtureService;
}

export function setDownloadsFixtureServiceForTesting(
  service: DownloadsFixtureService | null,
): void {
  downloadsFixtureService = service;
}

export function createDownloadsFixtureService(
  deps: DownloadsFixtureServiceDependencies = {},
): DownloadsFixtureService {
  return new DefaultDownloadsFixtureService(
    deps.resolveActiveSession ?? resolveActiveSessionDevice,
    deps.sharedStorage ?? getSharedStorageService,
    deps.registerPendingDeviceCleanup ?? registerPendingDeviceCleanup,
  );
}

function registerPendingDeviceCleanup(deviceId: string, cleanup: Promise<unknown>): void {
  const daemonState = DaemonState.getInstance();
  if (daemonState.isInitialized()) {
    daemonState.getSessionManager().registerPendingDeviceCleanup(deviceId, cleanup);
  }
}

class DefaultDownloadsFixtureService implements DownloadsFixtureService {
  constructor(
    private readonly resolveActiveSession: ActiveSessionResolver,
    private readonly sharedStorage: () => SharedStorageService,
    private readonly registerPendingDeviceCleanup: (
      deviceId: string,
      cleanup: Promise<unknown>,
    ) => void,
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
    // has settled.
    const stagedPromise = this.sharedStorage().stage(stageRequest);
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
}
