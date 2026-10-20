import type { BootedDevice } from "../../../models";
import type { Timer } from "../../../utils/SystemTimer";
import {
  NavigationGraphManager,
  type NavigationBuildContext,
} from "../../navigation/NavigationGraphManager";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { createIosMetadataSource } from "../../../utils/iosAppMetadataSource";
import { GetAppMetadata } from "../GetAppMetadata";
import { defaultAdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import {
  createContentHashProvider,
  type ContentHashProvider,
} from "../../../utils/ContentHashProvider";
import type { IosAppMetadataSource } from "../../../models/IosAppMetadataSource";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { exponentialBackoff } from "../../../utils/Backoff";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
type NavGraph = ReturnType<typeof NavigationGraphManager.getInstance>;
interface BuildContextHost {
  readonly device: BootedDevice;
  readonly timer: Timer;
  isClosed(): boolean;
  getNavigationGraphManager(): NavGraph;
}

/** Validate the platform version before it becomes a wire/cache key. */
function iosBuildVersion(raw: string): { versionCode: number; versionKey?: string } | null {
  const trimmed = raw.trim();
  // 64 characters accommodates build labels while bounding wire/cache keys.
  // Metadata and provenance share the trimmed platform value.
  if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    return null;
  }
  const numeric = Number(trimmed);
  if (/^\d+$/.test(trimmed) && Number.isSafeInteger(numeric)) {
    return { versionCode: numeric };
  }
  return { versionCode: 0, versionKey: trimmed };
}

interface IosBuildContextAttempt {
  generation: number;
  controller: AbortController;
  scheduledTimer?: ReturnType<Timer["setTimeout"]>;
}

type IosBuildContextResolution =
  | { kind: "resolved"; context: NavigationBuildContext }
  | { kind: "terminal"; reason: string }
  | { kind: "failed" | "superseded" };

const iosBuildContextBackoff = exponentialBackoff({
  initialDelayMs: 5000,
  multiplier: 2,
  maxDelayMs: 300000,
});

const IOS_BUILD_CONTEXT_DEADLINE_MS = 30000;
/** Session-bound build provenance with bounded asynchronous resolution. */
export class CtrlProxyBuildContext {
  private iosSource?: IosAppMetadataSource;

  private appMetadata?: GetAppMetadata;

  private contentHashProvider?: ContentHashProvider;

  private readonly resolvedBuildContexts = new Map<string, NavigationBuildContext>();

  private readonly buildContextInFlight = new Map<string, IosBuildContextAttempt>();

  private readonly buildContextFailures = new Map<string, { attempts: number; retryAt: number }>();

  private readonly appliedBuildContextManagers = new Map<string, Set<NavGraph>>();

  private readonly buildContextGeneration = new Map<string, number>();

  /** Resolve provenance out of band, re-applying it to the current session on every event. */
  ensureBuildContext(appId: string): void {
    if (this.host.isClosed()) {
      return;
    }
    const resolved = this.resolvedBuildContexts.get(appId);
    if (resolved) {
      this.applyBuildContext(resolved);
      return;
    }
    this.host.getNavigationGraphManager().clearBuildContext(appId);
    if (
      this.buildContextInFlight.has(appId) ||
      this.host.timer.now() < (this.buildContextFailures.get(appId)?.retryAt ?? 0)
    ) {
      return;
    }
    const generation = this.buildContextGeneration.get(appId) ?? 0;
    this.buildContextGeneration.set(appId, generation);
    const attempt: IosBuildContextAttempt = { generation, controller: new AbortController() };
    this.buildContextInFlight.set(appId, attempt);
    // Match Android's macrotask deferral: register the navigation write first,
    // before metadata lookup or hashing can do any I/O.
    attempt.scheduledTimer = this.host.timer.setTimeout(() => {
      attempt.scheduledTimer = undefined;
      if (this.isBuildContextAttemptCurrent(appId, attempt)) {
        void this.resolveBuildContext(appId, attempt);
      }
    }, 0);
  }

  private isBuildContextAttemptCurrent(appId: string, attempt: IosBuildContextAttempt): boolean {
    return (
      !this.host.isClosed() &&
      !attempt.controller.signal.aborted &&
      this.buildContextInFlight.get(appId) === attempt &&
      this.buildContextGeneration.get(appId) === attempt.generation
    );
  }

  private async readBuildContext(
    appId: string,
    attempt: IosBuildContextAttempt,
  ): Promise<IosBuildContextResolution> {
    if (!this.isBuildContextAttemptCurrent(appId, attempt)) {
      return { kind: "superseded" };
    }
    // Use metadata's existing transport predicate. Physical bundle paths belong
    // to the device filesystem and cannot be hashed by the host bundle walker.
    if (resolveIosDeviceKind({ deviceId: this.host.device.deviceId }) !== "simulator") {
      return { kind: "terminal", reason: "physical-device bundle hashing is unavailable" };
    }
    this.iosSource ??= createIosMetadataSource(this.host.device);
    this.appMetadata ??= new GetAppMetadata(
      this.host.device,
      defaultAdbClientFactory,
      this.iosSource,
    );
    const metadata = await this.appMetadata.execute(appId);
    if (!this.isBuildContextAttemptCurrent(appId, attempt)) {
      return { kind: "superseded" };
    }
    if (!metadata) {
      return { kind: "failed" };
    }
    const buildNumber = metadata.buildNumber.trim();
    const version = iosBuildVersion(buildNumber);
    if (version === null) {
      return {
        kind: "terminal",
        reason: `CFBundleVersion ${JSON.stringify(buildNumber)} is blank, over 64 characters, or contains controls`,
      };
    }
    this.contentHashProvider ??= createContentHashProvider(
      this.host.device,
      defaultAdbClientFactory.create(this.host.device),
      this.iosSource,
    );
    const contentHash = await this.contentHashProvider.resolveContentHash(
      this.host.device,
      appId,
      version.versionKey ?? version.versionCode,
    );
    if (contentHash === null) {
      return { kind: "failed" };
    }
    return {
      kind: "resolved",
      context: {
        appId,
        deviceId: this.host.device.deviceId,
        ...version,
        contentHash,
      },
    };
  }

  private async resolveBuildContext(
    appId: string,
    attempt: IosBuildContextAttempt,
  ): Promise<boolean> {
    try {
      const result = await raceWithDeadline(() => this.readBuildContext(appId, attempt), {
        timer: this.host.timer,
        timeoutMs: IOS_BUILD_CONTEXT_DEADLINE_MS,
        signal: attempt.controller.signal,
        label: `iOS build-context resolution for ${appId}`,
      });
      if (!this.isBuildContextAttemptCurrent(appId, attempt) || result.kind === "superseded") {
        return false;
      }
      if (result.kind === "failed") {
        this.recordBuildContextFailure(appId);
        return false;
      }
      if (result.kind === "terminal") {
        logger.info(
          `[IOSCtrlProxyClient] ${appId}: ${result.reason}; using device attribution with the unknown build key until invalidation`,
        );
      }
      // (0, "") is NavigationGraphManager's existing default/unknown build key.
      // Keep its device dimension without inventing a version or content hash;
      // observation rows remain separate by device/session under that same key.
      const context: NavigationBuildContext =
        result.kind === "resolved"
          ? result.context
          : {
              appId,
              deviceId: this.host.device.deviceId,
              versionCode: 0,
              contentHash: "",
            };
      this.applyBuildContext(context);
      this.resolvedBuildContexts.set(appId, context);
      this.buildContextFailures.delete(appId);
      return true;
    } catch (error) {
      if (!this.isBuildContextAttemptCurrent(appId, attempt)) {
        // Invalidation/close intentionally aborts optional provenance; no write is lost.
        logger.debug(
          `[IOSCtrlProxyClient] Build-context resolution cancelled for ${appId}: ${errorMessage(error)}`,
        );
        return false;
      }
      logger.warn(
        `[IOSCtrlProxyClient] Build-context resolution failed for ${appId}: ${errorMessage(error)}`,
        error,
      );
      this.recordBuildContextFailure(appId);
      return false;
    } finally {
      // The deadline helper observes late rejections; abort also prevents a late
      // metadata result from starting hashing after the race has already settled.
      attempt.controller.abort();
      if (this.buildContextInFlight.get(appId) === attempt) {
        this.buildContextInFlight.delete(appId);
      }
    }
  }

  private recordBuildContextFailure(appId: string): void {
    const attempts = (this.buildContextFailures.get(appId)?.attempts ?? 0) + 1;
    this.buildContextFailures.set(appId, {
      attempts,
      retryAt: this.host.timer.now() + iosBuildContextBackoff.delayForAttempt(attempts),
    });
  }

  private applyBuildContext(context: NavigationBuildContext): void {
    const manager = this.host.getNavigationGraphManager();
    manager.setBuildContext(context);
    let managers = this.appliedBuildContextManagers.get(context.appId);
    if (!managers) {
      managers = new Set();
      this.appliedBuildContextManagers.set(context.appId, managers);
    }
    managers.add(manager);
  }

  private clearClientBuildContext(appId: string): boolean {
    // Clear earlier session bindings too: close must not leave a released device
    // attributable on a manager to which this client previously applied context.
    const managers = this.appliedBuildContextManagers.get(appId) ?? new Set<NavGraph>();
    for (const manager of managers) {
      manager.clearBuildContext(appId);
    }
    this.appliedBuildContextManagers.delete(appId);
    try {
      this.host.getNavigationGraphManager().clearBuildContext(appId);
      return true;
    } catch (error) {
      logger.warn(
        `[IOSCtrlProxyClient] Could not clear build context for ${appId}: ${errorMessage(error)}`,
        error,
      );
      return false;
    }
  }

  invalidateBuildContext(appId: string): void {
    this.buildContextGeneration.set(appId, (this.buildContextGeneration.get(appId) ?? 0) + 1);
    const attempt = this.buildContextInFlight.get(appId);
    if (attempt?.scheduledTimer !== undefined) {
      this.host.timer.clearTimeout(attempt.scheduledTimer);
    }
    attempt?.controller.abort();
    this.buildContextInFlight.delete(appId);
    this.buildContextFailures.delete(appId);
    this.resolvedBuildContexts.delete(appId);
    this.contentHashProvider?.invalidate(this.host.device.deviceId, appId);
    this.clearClientBuildContext(appId);
  }
  constructor(
    private readonly host: BuildContextHost,
    options: { iosSource?: IosAppMetadataSource; contentHashProvider?: ContentHashProvider },
  ) {
    this.iosSource = options.iosSource;
    this.contentHashProvider = options.contentHashProvider;
  }
  dependencies() {
    return { iosSource: this.iosSource, contentHashProvider: this.contentHashProvider };
  }
  invalidateAll(): void {
    for (const appId of this.buildContextGeneration.keys()) {
      this.invalidateBuildContext(appId);
    }
  }
  close(): void {
    this.invalidateAll();
    this.buildContextGeneration.clear();
  }
  /** Read-only snapshot for testing lazy initialization and cancellation without exposing mutable state. */
  diagnostics() {
    return {
      pendingCount: this.buildContextInFlight.size,
      resolvedCount: this.resolvedBuildContexts.size,
      metadataSourceInitialized: this.iosSource !== undefined,
      appMetadataInitialized: this.appMetadata !== undefined,
      contentHashProviderInitialized: this.contentHashProvider !== undefined,
    };
  }
}
