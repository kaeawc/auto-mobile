import { iosHierarchyAcquisition } from "./ios/types";
import { linkWindowRoots } from "./linkWindowRoots";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { BootedDevice } from "../../models";
import { Element } from "../../models";
import { ScreenIdentity } from "../../models";
import { ViewHierarchyResult } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";
import type { ElementGeometry } from "../../utils/interfaces/ElementGeometry";
import { DefaultElementParser } from "../utility/ElementParser";
import { DefaultElementGeometry } from "../utility/ElementGeometry";
import { ViewHierarchyQueryOptions } from "../../models";
import { AndroidCtrlProxyClient } from "./android";
import { IOSCtrlProxyClient } from "./ios";
import { IosRunnerStalledError } from "./ios/runnerErrorCodes";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import { serverConfig } from "../../utils/ServerConfig";
import { attachRawViewHierarchy } from "../utility/viewHierarchySearch";
import type {
  ViewHierarchy as ViewHierarchyInterface,
  HierarchyReadOptions,
} from "./interfaces/ViewHierarchy";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import {
  normalizeIosHierarchy,
  projectActionableHierarchy,
  filterOffscreenNodes,
} from "./HierarchyNormalization";
import { HOST_OUTPUT_CHILD_CAP_REASON_PREFIX } from "./truncationReasons";
import type { CtrlProxyHierarchyResponse } from "./ios/types";
import { nodeAttributes, type Hierarchy } from "../../models/ViewHierarchyResult";
import {
  defaultObserveAccessibilityManagerFactory,
  recoverRootlessAccessibilityService,
  type ObserveAccessibilityManagerFactory,
} from "./android/ObserveAccessibilityRecovery";

function iosHierarchyUnavailable(result: CtrlProxyHierarchyResponse | null): Hierarchy {
  const reason = result?.unavailableReason ?? "unknown";
  const detail = result?.unavailableDetail;
  return {
    error: `Failed to retrieve iOS view hierarchy from CtrlProxy iOS: ${reason}${detail ? `: ${detail}` : ""}`,
    iosUnavailableReason: reason,
    unavailableReason: reason,
    unavailableDetail: detail,
  };
}

/**
 * Maximum number of direct children the raw-element-search filter walks per node.
 * The cap bounds the filtered payload on pathological containers (long lists,
 * wide grids); children past it are dropped, and every capped node is reported
 * through the hierarchy's `truncationReasons` so the drop is never silent (#6601).
 */
export const MAX_FILTERED_CHILDREN_PER_NODE = 64;
/** Reserve enough time for one useful device re-fetch after recovery. */
export const MIN_RECOVERY_REFETCH_BUDGET_MS = 100;

interface RecoveryReadContext {
  queryOptions?: ViewHierarchyQueryOptions;
  perf: PerformanceTracker;
  skipWaitForFresh: boolean;
  minTimestamp: number;
  signal?: AbortSignal;
  deadline?: number;
  requireFreshExtraction?: boolean;
}

export class ViewHierarchy implements ViewHierarchyInterface {
  private device: BootedDevice;
  private parser: ElementParser;
  private geometry: ElementGeometry;
  private accessibilityServiceClient: AndroidCtrlProxyClient;
  private adbFactory: AdbClientFactory;
  private timer: Timer;
  private observeAccessibilityManagerFactory: ObserveAccessibilityManagerFactory;

  /**
   * Create a ViewHierarchy instance
   * @param device - Device to get view hierarchy from
   * @param adbFactory - Factory for creating AdbClient instances
   * @param accessibilityServiceClient - Optional AndroidCtrlProxyClient instance for testing
   */
  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    accessibilityServiceClient: AndroidCtrlProxyClient | null = null,
    timer: Timer = defaultTimer,
    observeAccessibilityManagerFactory: ObserveAccessibilityManagerFactory = defaultObserveAccessibilityManagerFactory,
  ) {
    this.device = device;
    this.parser = new DefaultElementParser();
    this.geometry = new DefaultElementGeometry();

    this.accessibilityServiceClient =
      accessibilityServiceClient || AndroidCtrlProxyClient.getInstance(device, adbFactory);
    this.adbFactory = adbFactory;
    this.timer = timer;
    this.observeAccessibilityManagerFactory = observeAccessibilityManagerFactory;
  }

  async configureRecompositionTracking(
    enabled: boolean,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.device.platform !== "android") {
      return;
    }

    await this.accessibilityServiceClient.setRecompositionTrackingEnabled(enabled, perf, signal);
  }

  async getScreenIdentity(applicationId?: string): Promise<ScreenIdentity | undefined> {
    if (this.device.platform === "android") {
      return this.accessibilityServiceClient.getSdkScreenIdentity(applicationId);
    }
    if (this.device.platform !== "ios") {
      return undefined;
    }
    return IOSCtrlProxyClient.getExistingInstance(this.device.deviceId)?.refreshSdkScreenIdentity(
      applicationId,
    );
  }

  /**
   * Retrieve the view hierarchy of the current screen
   * @param queryOptions - Optional query options for targeted element retrieval
   * @param perf - Performance tracker for timing data
   * @param skipWaitForFresh - If true, skip WebSocket wait and go straight to sync method
   * @param minTimestamp - If provided, cached data must have updatedAt >= this value
   * @returns Promise with parsed XML view hierarchy
   */
  async getViewHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    signal?: AbortSignal,
    readOptions?: number | HierarchyReadOptions,
  ): Promise<ViewHierarchyResult> {
    if (this.device.platform !== "ios" && this.device.platform !== "android") {
      throw new Error("Unsupported platform");
    }
    const timeoutMs = typeof readOptions === "number" ? readOptions : readOptions?.timeoutMs;
    const deadline = timeoutMs === undefined ? undefined : this.timer.now() + timeoutMs;
    const result =
      this.device.platform === "ios"
        ? await this.getiOSViewHierarchy(perf, skipWaitForFresh, minTimestamp, timeoutMs, signal)
        : await this.getAndroidViewHierarchy(
            queryOptions,
            perf,
            skipWaitForFresh,
            minTimestamp,
            signal,
            readOptions,
          );
    return this.retryAfterTransportRecovery(result, {
      queryOptions,
      perf,
      skipWaitForFresh,
      minTimestamp,
      signal,
      deadline,
      requireFreshExtraction:
        typeof readOptions === "object" ? readOptions.requireFreshExtraction : undefined,
    });
  }

  private async retryAfterTransportRecovery(
    result: ViewHierarchyResult,
    context: RecoveryReadContext,
  ): Promise<ViewHierarchyResult> {
    if (context.signal?.aborted) {
      return result;
    }
    if (this.device.platform === "ios") {
      return this.retryIosAfterRecovery(result, context);
    }
    return this.retryAndroidAfterRecovery(result, context);
  }

  private remainingRecoveryBudget(context: RecoveryReadContext): number | undefined {
    return context.deadline === undefined
      ? undefined
      : Math.max(0, context.deadline - this.timer.now());
  }

  private hasRecoveryRefetchBudget(context: RecoveryReadContext): boolean {
    const remaining = this.remainingRecoveryBudget(context);
    return remaining === undefined || remaining >= MIN_RECOVERY_REFETCH_BUDGET_MS;
  }

  private recoveryWaitBudget(context: RecoveryReadContext, platformWaitMs: number): number {
    const remaining = this.remainingRecoveryBudget(context);
    return remaining === undefined
      ? platformWaitMs
      : Math.min(platformWaitMs, Math.max(0, remaining - MIN_RECOVERY_REFETCH_BUDGET_MS));
  }

  private async retryIosAfterRecovery(
    result: ViewHierarchyResult,
    context: RecoveryReadContext,
  ): Promise<ViewHierarchyResult> {
    const client = IOSCtrlProxyClient.getInstance(this.device);
    this.classifyDisconnectedIosHierarchy(result, client);
    if (
      (result.hierarchy.unavailableReason !== "runner_not_running" &&
        result.hierarchy.unavailableReason !== "runner_stalled" &&
        result.hierarchy.unavailableReason !== "connection_lost" &&
        result.hierarchy.unavailableReason !== "service_recovering" &&
        !(result.ctrlProxyReconnect && result.hierarchy.error)) ||
      !this.hasRecoveryRefetchBudget(context)
    ) {
      return result;
    }
    client.ensureRecoveryStarted();
    const recovery = await client.awaitRecovery(
      this.recoveryWaitBudget(context, IOSCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS),
      context.signal,
    );
    if (recovery !== "recovered" || !this.hasRecoveryRefetchBudget(context)) {
      if (recovery === "timed_out") {
        result.hierarchy.unavailableReason = "service_recovering";
        result.hierarchy.iosUnavailableReason = "service_recovering";
      }
      return result;
    }
    return this.getiOSViewHierarchy(
      context.perf,
      context.skipWaitForFresh,
      context.minTimestamp,
      this.remainingRecoveryBudget(context),
      context.signal,
    );
  }

  private classifyDisconnectedIosHierarchy(
    result: ViewHierarchyResult,
    client: IOSCtrlProxyClient,
  ): void {
    // A request-scoped runner error can be untyped while the host socket has
    // already closed. The known disconnect is sufficient to join recovery.
    if (result.hierarchy.unavailableReason === "unknown" && client.isConnected?.() === false) {
      result.hierarchy.unavailableReason = "connection_lost";
      result.hierarchy.iosUnavailableReason = "connection_lost";
    }
  }

  private async retryAndroidAfterRecovery(
    result: ViewHierarchyResult,
    context: RecoveryReadContext,
  ): Promise<ViewHierarchyResult> {
    const recoveredRootless = await this.retryRootlessAndroidCapture(result, context);
    if (recoveredRootless) {
      return recoveredRootless;
    }
    if (result.hierarchy.transportFailure !== true) {
      return result;
    }
    if (!this.hasRecoveryRefetchBudget(context)) {
      return result;
    }
    this.accessibilityServiceClient.ensureRecoveryStarted?.();
    if (
      (await this.accessibilityServiceClient.awaitRecovery?.(
        this.recoveryWaitBudget(context, AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS),
        context.signal,
      )) !== "recovered"
    ) {
      // This call may have started recovery after the first read assigned its reason.
      Object.assign(result.hierarchy, this.androidTransportFailureFields());
      return result;
    }
    if (!this.hasRecoveryRefetchBudget(context)) {
      return result;
    }
    return this.getAndroidViewHierarchy(
      context.queryOptions,
      context.perf,
      context.skipWaitForFresh,
      context.minTimestamp,
      context.signal,
      context.requireFreshExtraction
        ? {
            timeoutMs: this.remainingRecoveryBudget(context),
            requireFreshExtraction: context.requireFreshExtraction,
          }
        : this.remainingRecoveryBudget(context),
    );
  }

  /**
   * Typed cause for an Android transport failure. An exhausted or suspended forced-restart budget
   * means automatic recovery will not run again, so say so (with the last failure) rather than
   * reporting a generic `connection_lost` that implies a retry could help (#11246).
   */
  private androidTransportFailureFields(): Pick<
    Hierarchy,
    "unavailableReason" | "unavailableDetail"
  > {
    if (this.accessibilityServiceClient.isRecoveryInFlight?.()) {
      return { unavailableReason: "service_recovering" };
    }
    const budget = this.accessibilityServiceClient.getRestartBudgetSnapshot?.();
    if (budget && (budget.state === "exhausted" || budget.state === "suspended")) {
      return {
        unavailableReason: "runner_unavailable",
        unavailableDetail:
          `Automatic CtrlProxy recovery is ${budget.state} after ${budget.attempts} attempt(s)` +
          `${budget.lastFailureReason ? `; last failure: ${budget.lastFailureReason}` : ""}. ` +
          "Run startDevice or begin a new session to rearm it.",
      };
    }
    return { unavailableReason: "connection_lost" };
  }

  private async retryRootlessAndroidCapture(
    result: ViewHierarchyResult,
    context: RecoveryReadContext,
  ): Promise<ViewHierarchyResult | null> {
    if (
      result.hierarchy.transportFailure !== true &&
      !result.hierarchy.node &&
      !result.windows?.length &&
      result.hierarchy.unavailableReason !== "device_locked" &&
      this.hasRecoveryRefetchBudget(context) &&
      (await recoverRootlessAccessibilityService(
        this.observeAccessibilityManagerFactory(this.device),
        this.timer,
        this.recoveryWaitBudget(context, AndroidCtrlProxyClient.OBSERVE_RECOVERY_WAIT_MS),
        context.signal,
      )) &&
      this.hasRecoveryRefetchBudget(context)
    ) {
      return this.getAndroidViewHierarchy(
        context.queryOptions,
        context.perf,
        context.skipWaitForFresh,
        context.minTimestamp,
        context.signal,
        context.requireFreshExtraction
          ? {
              timeoutMs: this.remainingRecoveryBudget(context),
              requireFreshExtraction: context.requireFreshExtraction,
            }
          : this.remainingRecoveryBudget(context),
      );
    }
    return null;
  }

  /**
   * Retrieve the view hierarchy of the current screen
   * @param perf - Performance tracker for timing data
   * @param skipWaitForFresh - If true, skip waiting for fresh data and use cache if available
   * @param minTimestamp - If provided, cached data must have updatedAt >= this value
   * @param timeoutMs - Per-request budget for the synchronous CtrlProxy fetch
   * @param signal - Caller cancellation, forwarded to the CtrlProxy client. Without it this
   *   read is fenced ONLY by `timeoutMs` (default 15s below), so a caller whose own deadline is
   *   much tighter -- the #6866 embedded-observation settle gate advertises a 1s bound -- would
   *   block for the full default against a wedged runner. The Android branch has always
   *   forwarded it; dropping it here was the iOS asymmetry (#6890 review, P1).
   * @returns Promise with parsed XML view hierarchy
   */
  async getiOSViewHierarchy(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ViewHierarchyResult> {
    const startTime = this.timer.now();
    logger.info(
      `[VIEW_HIERARCHY] Starting getViewHierarchy for iOS (skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp})`,
    );

    perf.serial("ios_viewHierarchy");

    const xcTestClient = IOSCtrlProxyClient.getInstance(this.device);
    const viewHierarchy = await perf.track("ctrlProxyGetHierarchy", async () => {
      // Use getLatestHierarchy which properly handles skipWaitForFresh and minTimestamp
      let result: CtrlProxyHierarchyResponse | null;
      try {
        result = await xcTestClient.getLatestHierarchy(
          !skipWaitForFresh, // waitForFresh = opposite of skipWaitForFresh
          timeoutMs ?? 15000, // timeout: caller budget when supplied
          perf,
          skipWaitForFresh,
          minTimestamp,
          signal,
        );
      } catch (error) {
        if (!(error instanceof IosRunnerStalledError)) {
          throw error;
        }
        logger.warn(`[VIEW_HIERARCHY] ${error.message}`);
        result = {
          hierarchy: null,
          fresh: false,
          unavailableReason: "runner_stalled",
          unavailableDetail: error.message,
        };
      }

      if (!result || !result.hierarchy) {
        if (result?.reconnectStatus) {
          const reason = result.unavailableReason ?? "connection_lost";
          return {
            hierarchy: {
              error:
                result.reconnectMessage ??
                `CtrlProxy reconnecting, retry in ${result.reconnectStatus.retryAfterSeconds}s`,
              iosUnavailableReason: reason,
              unavailableReason: reason,
              unavailableDetail: result.unavailableDetail,
            },
            ctrlProxyReconnect: result.reconnectStatus,
            updatedAt: this.timer.now(),
          } as ViewHierarchyResult;
        }

        return {
          hierarchy: iosHierarchyUnavailable(result),
          updatedAt: this.timer.now(),
        };
      }

      // Convert XCTestHierarchy to ViewHierarchyResult format.
      // `result.fresh` says whether the delegate verified this tree against the
      // device on this call or served a host-side cache entry unverified; carry
      // it so ObserveScreen can report freshness instead of assuming it.
      return Object.assign(
        this.normalizeIosHierarchy(
          result.hierarchy,
          result.updatedAt,
          result.reconnectStatus,
          result.frameContext,
          result.fresh,
        ),
        { [iosHierarchyAcquisition]: result[iosHierarchyAcquisition] },
      );
    });

    perf.end();

    const duration = this.timer.now() - startTime;
    logger.info(
      `[VIEW_HIERARCHY] Successfully retrieved hierarchy from CtrlProxy iOS in ${duration}ms`,
    );
    return viewHierarchy;
  }

  /**
   * Convert XCTestHierarchy to ViewHierarchyResult format
   */
  normalizeIosHierarchy(
    hierarchy: any,
    updatedAt?: number,
    ctrlProxyReconnect?: ViewHierarchyResult["ctrlProxyReconnect"],
    frameContext?: string,
    fresh?: boolean,
  ): ViewHierarchyResult {
    return normalizeIosHierarchy(
      hierarchy,
      updatedAt ?? hierarchy.updatedAt ?? this.timer.now(),
      ctrlProxyReconnect,
      frameContext,
      fresh,
    );
  }

  projectActionableHierarchy(hierarchy: ViewHierarchyResult): ViewHierarchyResult {
    return projectActionableHierarchy(
      this.device.platform,
      hierarchy,
      this.device.platform === "ios" && (this.device.displays?.panels.length ?? 0) > 1,
    );
  }

  /**
   * Retrieve the view hierarchy of the current screen
   * @param queryOptions - Optional query options for targeted element retrieval
   * @param perf - Performance tracker for timing data
   * @param skipWaitForFresh - If true, skip WebSocket wait and go straight to sync method
   * @param minTimestamp - If provided, cached data must have updatedAt >= this value
   * @returns Promise with parsed view hierarchy
   */
  async getAndroidViewHierarchy(
    queryOptions?: ViewHierarchyQueryOptions,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    skipWaitForFresh: boolean = false,
    minTimestamp: number = 0,
    signal?: AbortSignal,
    readOptions?: number | HierarchyReadOptions,
  ): Promise<ViewHierarchyResult> {
    const timeoutMs = typeof readOptions === "number" ? readOptions : readOptions?.timeoutMs;
    const startTime = this.timer.now();
    logger.debug(
      `[VIEW_HIERARCHY] Starting Android getViewHierarchy (skipWaitForFresh=${skipWaitForFresh}, minTimestamp=${minTimestamp})`,
    );

    perf.serial("android_viewHierarchy");
    const useRawElementSearch = serverConfig.isRawElementSearchEnabled();

    try {
      const accessibilityHierarchy =
        await this.accessibilityServiceClient.getAccessibilityHierarchy(
          queryOptions,
          perf,
          skipWaitForFresh,
          minTimestamp,
          useRawElementSearch,
          signal,
          readOptions,
        );

      if (accessibilityHierarchy) {
        perf.end();
        const duration = this.timer.now() - startTime;
        logger.debug(
          `[VIEW_HIERARCHY] Successfully retrieved hierarchy from accessibility service in ${duration}ms`,
        );
        const prepared = this.prepareHierarchyForResponse(accessibilityHierarchy);
        if (prepared.hierarchy.transportFailure) {
          Object.assign(prepared.hierarchy, this.androidTransportFailureFields());
        } else if (prepared.ctrlProxyIncomplete && !prepared.hierarchy.node) {
          prepared.hierarchy.unavailableReason = "incomplete_capture";
        }
        return prepared;
      }

      // A null hierarchy may be a screen-off response, sync timeout, or runner
      // error while the socket is healthy. Only a disconnected transport is
      // evidence that reconnect/recovery can repair this read.
      perf.end();
      logger.warn("[VIEW_HIERARCHY] Accessibility service returned null hierarchy");
      const error = await this.describeHierarchyFailure(
        "Failed to retrieve view hierarchy from accessibility service",
        signal,
        timeoutMs,
      );
      // A confirmed keyguard block is a device state, so rebind cannot repair it.
      const deviceLocked = error.startsWith("Device is locked;");
      const transportFailure =
        !signal?.aborted &&
        !deviceLocked &&
        this.accessibilityServiceClient.isConnected?.() === false;
      return {
        hierarchy: {
          error,
          ...(transportFailure ? { transportFailure: true } : {}),
          ...(signal?.aborted
            ? {}
            : deviceLocked
              ? { unavailableReason: "device_locked" as const }
              : transportFailure || this.accessibilityServiceClient.isRecoveryInFlight?.()
                ? this.androidTransportFailureFields()
                : { unavailableReason: "unknown" as const }),
        },
        updatedAt: this.timer.now(),
      };
    } catch (err) {
      perf.end();
      const duration = this.timer.now() - startTime;
      logger.warn(
        `[VIEW_HIERARCHY] Failed to get hierarchy from accessibility service after ${duration}ms:`,
        err,
      );
      // Defensive/secondary path: the real `AndroidCtrlProxyClient` swallows
      // connection failures into a null return above rather than throwing, so
      // this catch is rarely reached in production through it. It stays for
      // other current or future client implementations, or a genuinely
      // different thrown error, that DO throw. Only mark it a transport
      // failure when the message matches a known connection/unbound-service
      // signature -- otherwise this is an ordinary/unexpected thrown error.
      const errMessage = errorMessage(err);
      const transportFailure =
        errMessage.includes("WebSocket not connected") ||
        errMessage.includes("Failed to connect to accessibility service");
      return {
        hierarchy: {
          error: await this.describeHierarchyFailure(
            "Failed to retrieve view hierarchy",
            signal,
            timeoutMs,
          ),
          ...(transportFailure ? { transportFailure: true } : {}),
          ...(transportFailure ? this.androidTransportFailureFields() : {}),
        },
        updatedAt: this.timer.now(),
      };
    }
  }

  /**
   * Turn a generic Android hierarchy failure into a lock-specific message when
   * the keyguard is actually blocking the app (#4281).
   *
   * A locked device — most commonly a fresh boot before the keyguard is first
   * dismissed — blocks Android from binding non-encryption-aware accessibility
   * services, so the hierarchy read fails with a message that points at the
   * service even though it is healthy. That is indistinguishable from the #4039
   * transport failure, which emits the identical string. Reading the lock state
   * over adb (a `dumpsys` path that works even while the service is unbound) lets
   * us name the real cause. Best-effort: any failure to read the lock state
   * falls back to `fallback`, so this never turns a real transport error into a
   * misleading "device is locked".
   */
  private async describeHierarchyFailure(
    fallback: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<string> {
    if (this.device.platform !== "android") {
      return fallback;
    }
    // Only reword the error for an unbudgeted (interactive) observe. A caller that
    // bounds each read -- an aborted signal, or a per-read `timeoutMs` like the
    // keyboard confirmation poll -- is latency-sensitive, and getDeviceLock's
    // `dumpsys window policy` is not itself bounded when no signal aborts it (the
    // keyboard path relies on `timeoutMs`, not a signal). So skip the probe rather
    // than risk blocking past the caller's deadline just to improve wording; the
    // main observe path (HierarchyCollector) passes no timeoutMs and still gets the
    // lock-specific message (#4281 review). The signal is still threaded through so
    // an in-flight dumpsys aborts with the request when one is present.
    if (signal?.aborted || timeoutMs !== undefined) {
      return fallback;
    }
    try {
      const lock = await this.adbFactory.create(this.device).getDeviceLock(signal);
      if (!lock?.locked) {
        return fallback;
      }
      const preamble =
        "Device is locked; a locked device blocks the accessibility service from binding, " +
        "so no view hierarchy is available.";
      if (lock.secure === true) {
        return `${preamble} Unlock the device (PIN/pattern/password) — you may need to ask the user — before observing.`;
      }
      if (lock.secure === false) {
        return `${preamble} Dismiss the keyguard (e.g. swipe up) before observing.`;
      }
      return `${preamble} Unlock or dismiss the keyguard before observing.`;
    } catch (error) {
      // Never let a lock-read failure mask a genuine transport error (#4039); a
      // debug trace is enough since the caller still returns an actionable error.
      logger.debug(`[VIEW_HIERARCHY] Could not read lock state for failure message: ${error}`);
      return fallback;
    }
  }

  /**
   * Check if node meets filter criteria (either string or boolean based)
   * @param props - Node properties
   * @returns True if node meets any filter criteria
   */
  public meetsFilterCriteria(props: any): boolean {
    return this.meetsStringFilterCriteria(props) || this.meetsBooleanFilterCriteria(props);
  }

  /**
   * Filter a single node and its children
   * @param node - Node to filter
   * @param isRootNode - Whether this is the root node
   * @param truncations - Optional sink collecting a reason per capped node
   * @returns Filtered node or null
   */
  public filterSingleNode(
    node: any,
    isRootNode: boolean = false,
    truncations?: string[],
  ): any | null {
    if (!node) {
      return null;
    }

    if (isRootNode) {
      const rootCopy = structuredClone(node);

      if (node.node) {
        // Always overwrite: when every child is filtered out the root must report an
        // empty child list rather than falling back to the raw cloned children.
        const processedChildren = this.processNodeChildren(
          node,
          (child) => this.filterSingleNode(child, false, truncations),
          truncations,
        );
        rootCopy.node = this.normalizeNodeStructure(processedChildren);
      }

      return rootCopy;
    }

    const props = nodeAttributes(node);
    const meetsFilterCriteria = this.meetsFilterCriteria(props);
    const relevantChildren = this.processNodeChildren(
      node,
      (child) => this.filterSingleNode(child, false, truncations),
      truncations,
    );

    if (meetsFilterCriteria || Number.isInteger(props.windowId)) {
      const cleanedNode = this.cleanNodeProperties(node);

      if (relevantChildren.length > 0) {
        cleanedNode.node = this.normalizeNodeStructure(relevantChildren);
      }

      return cleanedNode;
    }

    if (relevantChildren.length > 0) {
      return relevantChildren;
    }

    return null;
  }

  /**
   * Filter the view hierarchy to only include elements that meet specific criteria:
   * - Have resourceId, text, or contentDesc
   * - OR have clickable, scrollable, focused, or selected set to true
   * - Include descendants that meet criteria even if parents don't
   * - Omit false boolean fields except enabled and visible-to-user, and class="android.view.View"
   *
   * Each node's direct children are capped at {@link MAX_FILTERED_CHILDREN_PER_NODE};
   * every capped node contributes a `max_children[...]` entry to the returned
   * hierarchy's `truncationReasons` so callers can tell a short child list from a
   * truncated one (#6601).
   * @param viewHierarchy - The view hierarchy to filter
   * @returns Filtered view hierarchy with any `truncationReasons` appended
   */
  filterViewHierarchy(viewHierarchy: any): any {
    if (!viewHierarchy || !viewHierarchy.hierarchy) {
      logger.debug("No hierarchy found");
      return viewHierarchy;
    }

    const result = structuredClone(viewHierarchy);
    const truncations: string[] = [];
    result.hierarchy = this.filterSingleNode(viewHierarchy.hierarchy, true, truncations);
    if (result.windows) {
      result.windows = linkWindowRoots(result.hierarchy, result.windows);
    }
    if (truncations.length > 0) {
      // Surface the per-node child cap on the same channel as device-side
      // truncation (#6601) so an agent reading the rendered rows knows they were
      // cut — but it is an OUTPUT cap, not a partial capture: the uncapped tree
      // rides along as the raw carrier, so fidelity checks filter it out via
      // `captureFidelityTruncationReasons` (#6601 review).
      result.truncationReasons = [...(result.truncationReasons ?? []), ...truncations];
      logger.debug(`filterViewHierarchy capped children: ${truncations.join("; ")}`);
    }
    return result;
  }

  private prepareHierarchyForResponse(rawHierarchy: ViewHierarchyResult): ViewHierarchyResult {
    if (!serverConfig.isRawElementSearchEnabled()) {
      return rawHierarchy;
    }

    if (
      rawHierarchy?.hierarchy &&
      typeof rawHierarchy.hierarchy === "object" &&
      "error" in rawHierarchy.hierarchy &&
      rawHierarchy.hierarchy.error
    ) {
      return rawHierarchy;
    }

    if (this.device.platform !== "android") {
      return rawHierarchy;
    }

    const filtered = this.filterViewHierarchy(rawHierarchy);
    attachRawViewHierarchy(filtered, rawHierarchy);
    return filtered;
  }

  /** Preserve the shared offscreen projection used by observe and action captures. */
  filterOffscreenNodes(hierarchy: any, width: number, height: number, margin = 100): any {
    return filterOffscreenNodes(hierarchy, width, height, margin);
  }

  /**
   * Check if node meets string-based filter criteria
   * @param props - Node properties
   * @returns True if node has meaningful string properties
   */
  meetsStringFilterCriteria(props: any): boolean {
    const stringProperties = [
      "resourceId",
      "resource-id",
      "viewId",
      "view-id",
      "text",
      "contentDesc",
      "content-desc",
      "test-tag",
      "unique-id",
      "container-title",
      "role",
      "state-description",
      "error-message",
      "hint-text",
      "tooltip-text",
      "pane-title",
      "live-region",
      "collection-info",
      "collection-item-info",
      "range-info",
      "input-type",
    ];
    return Boolean(
      stringProperties.some((key) => props[key] && props[key] !== "") ||
      props.recomposition ||
      props.recompositionMetrics,
    );
  }

  /**
   * Check if node meets boolean-based filter criteria
   * @param props - Node properties
   * @returns True if node has meaningful boolean properties
   */
  meetsBooleanFilterCriteria(props: any): boolean {
    const booleanProperties = [
      "clickable",
      "focusable",
      "scrollable",
      "focused",
      "accessibility-focused",
      "checkable",
      "checked",
      "selected",
    ];
    return Boolean(
      booleanProperties.some((key) => props[key] === "true") ||
      props.selected === true ||
      props["long-clickable"] === "true" ||
      (Array.isArray(props.actions) && props.actions.length > 0) ||
      (props.extras && Object.keys(props.extras).length > 0),
    );
  }

  /**
   * Describe a node whose children were capped, for a truncation reason string.
   * Commas are avoided because PerformanceAuditor joins reasons with ", ".
   */
  private describeTruncatedNode(node: any): string {
    const props = nodeAttributes(node);
    const identity =
      props["resource-id"] || props["view-id"] || props["content-desc"] || props.class;
    return typeof identity === "string" && identity !== ""
      ? identity.replace(/,/g, " ")
      : "unknown-node";
  }

  /**
   * Process node children with filter function
   * @param node - Parent node
   * @param filterFn - Filter function to apply to children
   * @param truncations - Optional sink collecting a reason per capped node
   * @returns Array of filtered children
   */
  processNodeChildren(node: any, filterFn: (child: any) => any, truncations?: string[]): any[] {
    const relevantChildren: any[] = [];

    if (!node.node) {
      return relevantChildren;
    }
    const allChildren = Array.isArray(node.node) ? node.node : [node.node];
    if (allChildren.length > MAX_FILTERED_CHILDREN_PER_NODE && truncations) {
      truncations.push(
        `${HOST_OUTPUT_CHILD_CAP_REASON_PREFIX}${this.describeTruncatedNode(node)} kept ${MAX_FILTERED_CHILDREN_PER_NODE} of ${allChildren.length}]`,
      );
    }
    const children = allChildren.slice(0, MAX_FILTERED_CHILDREN_PER_NODE);
    for (const child of children) {
      const filteredChild = filterFn(child);
      if (filteredChild) {
        if (Array.isArray(filteredChild)) {
          relevantChildren.push(...filteredChild);
        } else {
          relevantChildren.push(filteredChild);
        }
      }
    }

    return relevantChildren;
  }

  /**
   * Normalize node structure for filtered children
   * @param filteredChildren - Array of filtered children
   * @returns Normalized node structure (single item or array)
   */
  normalizeNodeStructure(filteredChildren: any[]): any {
    return filteredChildren.length === 1 ? filteredChildren[0] : filteredChildren;
  }

  /**
   * Find the focused element in the view hierarchy
   * @param viewHierarchy - The view hierarchy to search
   * @returns The focused element or null if none found
   */
  findFocusedElement(viewHierarchy: any): Element | null {
    return this.findElementByProperty(viewHierarchy, "focused");
  }

  /**
   * Find the accessibility-focused element (TalkBack cursor position) in the view hierarchy.
   * First checks the top-level accessibility-focused-element field, then traverses if needed.
   */
  findAccessibilityFocusedElement(viewHierarchy: any): Element | null {
    if (!viewHierarchy) {
      return null;
    }

    // First check if accessibility-focused-element is provided at the top level (from Kotlin)
    if (viewHierarchy["accessibility-focused-element"]) {
      const element = this.parseNodeBounds(viewHierarchy["accessibility-focused-element"]);
      if (element) {
        element["accessibility-focused"] = true;
        return element;
      }
    }

    // Fallback: traverse the hierarchy to find the accessibility-focused element
    return this.findElementByProperty(viewHierarchy, "accessibility-focused");
  }

  private findElementByProperty(viewHierarchy: any, propertyName: string): Element | null {
    if (!viewHierarchy) {
      return null;
    }

    let foundElement: Element | null = null;

    const traverseNode = (node: any): void => {
      if (foundElement) {
        return;
      }

      const props = nodeAttributes(node);
      if (props[propertyName] === "true" || props[propertyName] === true) {
        const element = this.parseNodeBounds(node);
        if (element) {
          element[propertyName] = true;
          foundElement = element;
          return;
        }
      }

      if (node.node) {
        const children = Array.isArray(node.node) ? node.node : [node.node];
        for (const child of children) {
          traverseNode(child);
          if (foundElement) {
            break;
          }
        }
      }
    };

    if (viewHierarchy.hierarchy) {
      traverseNode(viewHierarchy.hierarchy);
    }

    return foundElement;
  }

  /**
   * Calculate the center coordinates of an element
   * @param element - The element to calculate center for
   * @returns The center coordinates
   */
  getElementCenter(element: Element): { x: number; y: number } {
    return this.geometry.getElementCenter(element);
  }

  /**
   * Parse a node's bounds into the object bounds format.
   * @param node - The node to parse
   * @returns The node with parsed bounds or null
   */
  parseNodeBounds(node: any): Element | null {
    return this.parser.parseNodeBounds(node);
  }

  /**
   * Traverse the view hierarchy and process each node with a provided function
   * @param node - The node to start traversal from
   * @param processNode - Function to process each node
   */
  traverseViewHierarchy(node: any, processNode: (node: any) => void): void {
    this.parser.traverseNode(node, processNode);
  }

  cleanNodeProperties(node: any): any {
    const result: any = {};
    const allowedProperties = [
      "windowId",
      "text",
      "resourceId",
      "resource-id",
      "viewId",
      "view-id",
      "contentDesc",
      "content-desc",
      "clickable",
      "long-clickable",
      "semantic-links",
      "scrollable",
      "enabled",
      "focusable",
      "focused",
      "accessibility-focused",
      "checkable",
      "checked",
      "selected",
      "bounds",
      "test-tag",
      "unique-id",
      "collection-row-index",
      "collection-column-index",
      "visible-to-user",
      "container-title",
      "role",
      "state-description",
      "error-message",
      "hint-text",
      "tooltip-text",
      "pane-title",
      "live-region",
      "collection-info",
      "collection-item-info",
      "range-info",
      "input-type",
      "actions",
      "extras",
      "occlusionState",
      "occludedBy",
      "occludedByViewId",
      "recomposition",
      "recompositionMetrics",
    ];

    if (node["$"]) {
      const cleanedProps: any = {};
      this.copyCleanAttributeBag(node.$, cleanedProps, allowedProperties);

      if (Object.keys(cleanedProps).length > 0) {
        for (const key in cleanedProps) {
          result[key] = cleanedProps[key];
        }
      }

      for (const key in node) {
        if (key !== "$" && key !== "node") {
          result[key] = node[key];
        }
      }
    } else {
      for (const key in node) {
        if (key === "node") {
          continue;
        }
        if (!allowedProperties.includes(key)) {
          continue;
        }
        if (this.shouldOmitNodeProperty(node, key)) {
          continue;
        }
        result[key] = node[key];
      }
    }

    return result;
  }

  private copyCleanAttributeBag(
    props: Record<string, unknown>,
    result: Record<string, unknown>,
    allowedProperties: readonly string[],
  ): void {
    for (const key in props) {
      if (!allowedProperties.includes(key)) {
        continue;
      }
      const normalizedKey =
        key === "resourceId" ? "resource-id" : key === "contentDesc" ? "content-desc" : key;
      if (this.shouldOmitNodeProperty(props, key)) {
        continue;
      }
      result[normalizedKey] = props[key];
    }
  }

  private shouldOmitNodeProperty(props: Record<string, unknown>, key: string): boolean {
    if (props[key] === "") {
      return true;
    }
    if (key === "enabled" && (props[key] === true || props[key] === "true")) {
      return true;
    }
    if (
      key !== "enabled" &&
      key !== "visible-to-user" &&
      (props[key] === false || props[key] === "false")
    ) {
      return true;
    }
    return false;
  }
}
