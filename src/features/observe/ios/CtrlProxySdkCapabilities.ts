import {
  combineAbortSignals,
  combineWithAmbientAbort,
  getRequestContext,
  runOutsideRequestContext,
} from "../../../utils/AbortContext";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { Timer } from "../../../utils/SystemTimer";
import type { BaseResult } from "../shared/types";
import type { DelegateContext } from "./types";
import { IOS_HIERARCHY_REQUEST_TIMEOUT_MS } from "./CtrlProxyHierarchy";
import { SdkCapabilityQueryError } from "./SdkCapabilityQueryError";
import { WEBSOCKET_NOT_CONNECTED_MESSAGE, sendCommand } from "../DeviceServiceUtils";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import {
  SdkCapabilityProbeSupersededError,
  type IosSdkCapability,
} from "./SdkCapabilityProbeSupersededError";
import {
  observationBridgeUnavailable,
  parseObservationBridgeState,
  type IosObservationBridgeState,
} from "./observationBridgeState";
export interface SdkCapabilityQueryOptions {
  deadlineMs?: number;
  abortSignal?: AbortSignal;
}

/** Share one absolute budget between a capability gate and its subsequent command. */
export function sdkCapabilityQueryOptions(
  timer: Pick<Timer, "now">,
  timeoutMs?: number,
  abortSignal?: AbortSignal,
): SdkCapabilityQueryOptions {
  const ambientDeadline = getRequestContext()?.getDeadlineMs?.();
  const deadlineMs =
    timeoutMs === undefined
      ? ambientDeadline
      : Math.min(timer.now() + Math.max(0, timeoutMs), ambientDeadline ?? Infinity);
  return { deadlineMs, abortSignal: combineWithAmbientAbort(abortSignal) };
}

interface SdkCapabilitiesHost {
  readonly timer: Timer;
  getSupportedCommands(): Set<string> | null;
  isCommandSupported(messageType: string): boolean;
  createDelegateContext(): DelegateContext;
  syncNetworkMockRulesToDevice(): unknown;
  syncNetworkErrorSimulationToDevice(): void;
}

interface IosSdkCapabilities {
  bundleId: string;
  capabilities: Set<IosSdkCapability>;
  observationBridge: IosObservationBridgeState;
}

interface IosSdkCapabilitiesResult extends BaseResult {
  available?: boolean;
  probeError?: SdkCapabilityQueryError;
  unsupported?: boolean;
  bundleId?: string;
  capabilities?: string[];
  observationBridge?: unknown;
}
type SdkCapabilityProbeResult =
  | { status: "capabilities"; capabilities: IosSdkCapabilities }
  | { status: "unavailable" }
  | { status: "unknown"; error: SdkCapabilityQueryError | SdkCapabilityProbeSupersededError };

const commandByCapability: Record<IosSdkCapability, string> = {
  hierarchy: "request_hierarchy",
  network_mocking: "set_network_mock_rules",
  network_fault_rules: "set_network_fault_rules",
  network_error_simulation: "set_network_error_simulation",
  database: "execute_sql",
  highlight: "add_highlight",
  magic_tap: "request_magic_tap",
};

/** Generation-bound SDK negotiation and capability gates. */
export class CtrlProxySdkCapabilities {
  constructor(private readonly host: SdkCapabilitiesHost) {}

  private sdkCapabilities: IosSdkCapabilities | null = null;

  private sdkCapabilitiesKnown = false;

  private sdkCapabilitiesKnownAt = 0;

  private sdkCapabilityGeneration = 0;

  private sdkCapabilityRefreshInFlight: {
    generation: number;
    controller: AbortController;
    waiters: number;
    promise: Promise<SdkCapabilityProbeResult>;
  } | null = null;

  private static readonly SDK_CAPABILITY_NEGATIVE_CACHE_TTL_MS = 5000;

  invalidateSdkCapabilities(): void {
    this.sdkCapabilityGeneration++;
    this.sdkCapabilities = null;
    this.sdkCapabilitiesKnown = false;
    this.sdkCapabilitiesKnownAt = 0;
    this.sdkCapabilityRefreshInFlight = null;
  }

  hasSdkCapability(capability: IosSdkCapability, bundleId?: string): boolean {
    return CtrlProxySdkCapabilities.capabilitiesInclude(this.sdkCapabilities, capability, bundleId);
  }

  /** Read the foreground generation's SDK presence without starting a capability probe. */
  getSdkAvailability(bundleId: string): boolean | undefined {
    if (!this.sdkCapabilitiesKnown) {
      return undefined;
    }
    if (this.sdkCapabilities) {
      return this.sdkCapabilities.bundleId === bundleId ? true : undefined;
    }
    return this.host.timer.now() - this.sdkCapabilitiesKnownAt <
      CtrlProxySdkCapabilities.SDK_CAPABILITY_NEGATIVE_CACHE_TTL_MS
      ? false
      : undefined;
  }

  private static capabilitiesInclude(
    capabilities: IosSdkCapabilities | null,
    capability: IosSdkCapability,
    bundleId?: string,
  ): boolean {
    const normalizedBundleId = bundleId?.trim();
    return (
      capabilities !== null &&
      (normalizedBundleId === undefined || capabilities.bundleId === normalizedBundleId) &&
      capabilities.capabilities.has(capability)
    );
  }

  private async refreshSdkCapabilities(
    options: SdkCapabilityQueryOptions,
  ): Promise<SdkCapabilityProbeResult> {
    if (!this.host.isCommandSupported("get_sdk_capabilities")) {
      this.sdkCapabilities = null;
      this.sdkCapabilitiesKnown = true;
      return { status: "unavailable" };
    }

    // Do not start shared work for a caller that has already left.
    if (
      options.abortSignal?.aborted ||
      (options.deadlineMs !== undefined && options.deadlineMs <= this.host.timer.now())
    ) {
      return this.waitForSharedProbe(Promise.resolve({ status: "unavailable" }), options);
    }
    const generation = this.sdkCapabilityGeneration;
    if (this.sdkCapabilityRefreshInFlight?.generation === generation) {
      return this.waitForProbe(this.sdkCapabilityRefreshInFlight, options);
    }

    // The probe owns its timeout/retry budget; no request's ambient deadline or
    // signal may terminate work that another caller is still waiting for.
    const controller = new AbortController();
    const promise = runOutsideRequestContext(() =>
      this.requestSdkCapabilities(generation, { abortSignal: controller.signal }),
    );
    const inFlight = { generation, controller, waiters: 0, promise };
    this.sdkCapabilityRefreshInFlight = inFlight;
    void promise
      .finally(() => {
        if (this.sdkCapabilityRefreshInFlight === inFlight) {
          this.sdkCapabilityRefreshInFlight = null;
        }
      })
      .catch((error) => {
        if (error instanceof SdkCapabilityProbeSupersededError) {
          // The newer foreground generation refreshes its own capabilities.
          logger.debug(`[IOSCtrlProxyClient] SDK capability refresh superseded: ${error.message}`);
          return;
        }
        logger.warn(
          `[IOSCtrlProxyClient] SDK capability refresh cleanup failed: ${errorMessage(error)}`,
          error,
        );
      });
    return this.waitForProbe(inFlight, options);
  }

  private async waitForProbe(
    inFlight: NonNullable<CtrlProxySdkCapabilities["sdkCapabilityRefreshInFlight"]>,
    options: SdkCapabilityQueryOptions,
  ): Promise<SdkCapabilityProbeResult> {
    inFlight.waiters++;
    try {
      return await this.waitForSharedProbe(inFlight.promise, options);
    } finally {
      inFlight.waiters--;
      if (inFlight.waiters === 0) {
        if (this.sdkCapabilityRefreshInFlight === inFlight) {
          this.sdkCapabilityRefreshInFlight = null;
        }
        inFlight.controller.abort();
      }
    }
  }

  private async waitForSharedProbe(
    promise: Promise<SdkCapabilityProbeResult>,
    options: SdkCapabilityQueryOptions,
  ): Promise<SdkCapabilityProbeResult> {
    let failure: unknown;
    try {
      if (options.deadlineMs !== undefined && options.deadlineMs <= this.host.timer.now()) {
        throw new SdkCapabilityQueryError(
          "timeout",
          "SDK capability query exhausted the caller deadline",
        );
      }
      return await raceWithDeadline(promise, {
        timer: this.host.timer,
        timeoutMs:
          options.deadlineMs === undefined
            ? undefined
            : Math.max(0, options.deadlineMs - this.host.timer.now()),
        signal: options.abortSignal,
        label: "SDK capability query",
        timeoutError: () =>
          new SdkCapabilityQueryError(
            "timeout",
            "SDK capability query exhausted the caller deadline",
          ),
      });
    } catch (error) {
      if (error instanceof SdkCapabilityProbeSupersededError) {
        throw error;
      }
      // Caller deadlines/cancellation end only this waiter; the shared probe stays valid.
      logger.debug(
        error instanceof SdkCapabilityQueryError
          ? "[IOSCtrlProxyClient] SDK capability waiter deadline expired"
          : "[IOSCtrlProxyClient] SDK capability waiter cancelled",
        error,
      );
      failure = error;
    }
    if (failure instanceof SdkCapabilityQueryError) {
      return { status: "unknown", error: failure };
    }
    return {
      status: "unknown",
      error: new SdkCapabilityQueryError("cancelled", "SDK capability query cancelled", {
        cause: failure,
      }),
    };
  }

  async requestSdkCapabilities(
    generation: number,
    options: SdkCapabilityQueryOptions = sdkCapabilityQueryOptions(this.host.timer),
  ): Promise<SdkCapabilityProbeResult> {
    let result = await this.sendSdkCapabilityQuery(options);
    // This read is safe to retry, but never re-probe an invalidated foreground generation.
    if (
      result.probeError?.code === "timeout" &&
      generation === this.sdkCapabilityGeneration &&
      !options.abortSignal?.aborted &&
      (options.deadlineMs === undefined || options.deadlineMs > this.host.timer.now())
    ) {
      result = await this.sendSdkCapabilityQuery(options);
    }
    if (generation !== this.sdkCapabilityGeneration) {
      return {
        status: "unknown",
        error: new SdkCapabilityProbeSupersededError(
          "hierarchy",
          generation,
          this.sdkCapabilityGeneration,
        ),
      };
    }
    if (result.probeError) {
      return { status: "unknown", error: result.probeError };
    }
    if (result.unsupported) {
      return { status: "unavailable" };
    }
    return this.cacheSdkCapabilityReply(result);
  }

  private cacheSdkCapabilityReply(result: IosSdkCapabilitiesResult): SdkCapabilityProbeResult {
    if (
      !result.success ||
      result.available === undefined ||
      (result.available && !result.bundleId)
    ) {
      return {
        status: "unknown",
        error: new SdkCapabilityQueryError(
          result.error === "Request deadline expired before dispatch"
            ? "timeout"
            : "sdk_capability_query_failed",
          `SDK capability query failed: ${result.error ?? "invalid capability reply"}`,
        ),
      };
    }

    const capabilities: IosSdkCapabilities | null =
      result.available && result.bundleId
        ? {
            bundleId: result.bundleId,
            capabilities: new Set(
              (result.capabilities ?? []).filter((capability): capability is IosSdkCapability =>
                Object.hasOwn(commandByCapability, capability),
              ),
            ),
            observationBridge: parseObservationBridgeState(result.observationBridge),
          }
        : null;

    this.sdkCapabilities = capabilities;
    this.sdkCapabilitiesKnown = true;
    this.sdkCapabilitiesKnownAt = this.host.timer.now();
    return capabilities ? { status: "capabilities", capabilities } : { status: "unavailable" };
  }

  private async sendSdkCapabilityQuery(
    options: SdkCapabilityQueryOptions,
  ): Promise<IosSdkCapabilitiesResult> {
    const timeoutMs =
      options.deadlineMs === undefined
        ? IOS_HIERARCHY_REQUEST_TIMEOUT_MS
        : Math.max(0, options.deadlineMs - this.host.timer.now());
    const timeoutError = () =>
      new SdkCapabilityQueryError(
        "timeout",
        `SDK capability query timed out after ${timeoutMs} ms`,
      );
    const controller = new AbortController();
    const abortSignal = combineAbortSignals(options.abortSignal, controller.signal);
    let failure: unknown;
    try {
      if (timeoutMs <= 0) {
        throw timeoutError();
      }
      return await raceWithDeadline(
        () =>
          sendCommand<IosSdkCapabilitiesResult>(this.host.createDelegateContext(), {
            idPrefix: "sdkCapabilities",
            responseType: "sdk_capabilities",
            messageType: "get_sdk_capabilities",
            timeoutMs,
            deadlineMs: options.deadlineMs,
            abortSignal,
            cancelScreenshotBackoff: false,
            errorLabel: "SDK capability query",
            notConnectedError: () => {
              options.abortSignal?.throwIfAborted();
              return {
                success: false,
                totalTimeMs: 0,
                probeError: new SdkCapabilityQueryError(
                  "not_connected",
                  "SDK capability query not connected to CtrlProxy",
                ),
              };
            },
            timeoutError: (timeoutMs) => ({
              success: false,
              totalTimeMs: timeoutMs,
              probeError: new SdkCapabilityQueryError(
                "timeout",
                `SDK capability query timed out after ${timeoutMs} ms`,
              ),
            }),
            responseError: (error, totalTimeMs) => ({
              success: false,
              totalTimeMs,
              error,
              // The inbound handler records older runners' explicit unknown-command refusals.
              unsupported: !this.host.isCommandSupported("get_sdk_capabilities"),
            }),
            unsupportedCommandError: () => ({
              success: false,
              available: false,
              unsupported: true,
              totalTimeMs: 0,
            }),
          }),
        {
          timer: this.host.timer,
          timeoutMs,
          signal: options.abortSignal,
          label: "SDK capability query",
          timeoutError,
          onTimeout: () => controller.abort(timeoutError()),
        },
      );
    } catch (error) {
      failure = error;
      if (options.abortSignal?.aborted) {
        // No caller still needs this request, or a direct caller cancelled it.
        logger.debug("[IOSCtrlProxyClient] SDK capability query cancelled", error);
      } else {
        logger.warn(
          error instanceof SdkCapabilityQueryError
            ? "[IOSCtrlProxyClient] SDK capability query failed"
            : `[IOSCtrlProxyClient] SDK capability query failed: ${errorMessage(error)}`,
          error,
        );
      }
    }
    if (options.abortSignal?.aborted) {
      return {
        success: false,
        totalTimeMs: 0,
        probeError: new SdkCapabilityQueryError("cancelled", "SDK capability query cancelled", {
          cause: failure,
        }),
      };
    }
    if (failure instanceof SdkCapabilityQueryError) {
      return { success: false, totalTimeMs: timeoutMs, probeError: failure };
    }
    // Socket loss/send failures reject the request rather than using a fallback builder.
    const message = errorMessage(failure);
    return {
      success: false,
      totalTimeMs: 0,
      probeError: new SdkCapabilityQueryError(
        message === WEBSOCKET_NOT_CONNECTED_MESSAGE || message === "WebSocket connection closed"
          ? "not_connected"
          : "sdk_capability_query_failed",
        `SDK capability query failed: ${message}`,
        { cause: failure },
      ),
    };
  }

  async refreshSdkCapabilitiesAndSync(
    options: SdkCapabilityQueryOptions = sdkCapabilityQueryOptions(this.host.timer),
  ): Promise<void> {
    const capabilities = await this.refreshSdkCapabilities(options);
    if (capabilities.status === "unknown") {
      throw capabilities.error;
    }
    if (capabilities.status === "unavailable") {
      if (this.host.getSupportedCommands()?.has("get_sdk_capabilities") === false) {
        this.host.syncNetworkMockRulesToDevice();
        this.host.syncNetworkErrorSimulationToDevice();
      }
      return;
    }
    this.host.syncNetworkMockRulesToDevice();
    this.host.syncNetworkErrorSimulationToDevice();
  }

  private sdkUnavailableResult(capability: IosSdkCapability): BaseResult {
    return {
      success: false,
      totalTimeMs: 0,
      error: `The foreground iOS app does not expose the AutoMobile SDK capability ${capability}.`,
    };
  }

  async ensureSdkCapability(
    capability: IosSdkCapability,
    bundleId?: string,
    options: SdkCapabilityQueryOptions = sdkCapabilityQueryOptions(this.host.timer),
  ): Promise<boolean> {
    if (!this.host.getSupportedCommands()?.has("get_sdk_capabilities")) {
      return this.isLegacySdkCommandSupported(capability);
    }
    return CtrlProxySdkCapabilities.capabilitiesInclude(
      await this.currentSdkCapabilities(capability, options),
      capability,
      bundleId,
    );
  }

  /**
   * Whether the foreground app's SDK observation bridge is available (#5159). Throws the probe's
   * `SdkCapabilityQueryError` when the runner does not answer, so a caller never mistakes a failed
   * probe for an unavailable bridge.
   */
  async getObservationBridgeState(
    bundleId: string,
    options: SdkCapabilityQueryOptions = sdkCapabilityQueryOptions(this.host.timer),
  ): Promise<IosObservationBridgeState> {
    const supportedCommands = this.host.getSupportedCommands();
    if (supportedCommands === null) {
      return observationBridgeUnavailable("SDK_UNAVAILABLE");
    }
    if (!supportedCommands.has("get_sdk_capabilities")) {
      return observationBridgeUnavailable("SDK_TOO_OLD");
    }
    const capabilities = await this.currentSdkCapabilities("observation_bridge", options);
    if (capabilities === null || capabilities.bundleId !== bundleId.trim()) {
      return observationBridgeUnavailable("SDK_UNAVAILABLE");
    }
    return capabilities.observationBridge;
  }

  /**
   * The current foreground generation's capabilities: the cache while it is valid, otherwise a
   * fresh probe. `null` means no SDK. Throws when the probe fails or is superseded.
   */
  private async currentSdkCapabilities(
    requested: IosSdkCapability | "observation_bridge",
    options: SdkCapabilityQueryOptions,
  ): Promise<IosSdkCapabilities | null> {
    if (this.sdkCapabilitiesKnown) {
      if (
        (this.sdkCapabilities === null ||
          (requested === "observation_bridge" &&
            this.sdkCapabilities.observationBridge.status === "unavailable")) &&
        this.host.timer.now() - this.sdkCapabilitiesKnownAt >=
          CtrlProxySdkCapabilities.SDK_CAPABILITY_NEGATIVE_CACHE_TTL_MS
      ) {
        this.sdkCapabilitiesKnown = false;
      } else {
        return this.sdkCapabilities;
      }
    }
    // Generation binding (#6896): the waiter records the generation it was created
    // under and decides ONLY from that generation's probe result. A hierarchy update
    // can invalidate this generation and complete a replacement probe for another
    // foreground app before this probe answers; rereading the shared cache here
    // would let that app's capabilities authorize this waiter.
    const probeGeneration = this.sdkCapabilityGeneration;
    const probed = await this.refreshSdkCapabilities(options);
    if (probeGeneration !== this.sdkCapabilityGeneration) {
      throw new SdkCapabilityProbeSupersededError(
        requested,
        probeGeneration,
        this.sdkCapabilityGeneration,
      );
    }
    if (probed.status === "unknown") {
      throw probed.error;
    }
    return probed.status === "capabilities" ? probed.capabilities : null;
  }

  /**
   * Result-returning variant of `ensureSdkCapability` for callers that report
   * failures as a `BaseResult` instead of throwing: `null` means the capability
   * is available; otherwise the actionable failure to return as-is.
   */
  async sdkCapabilityGate(
    capability: IosSdkCapability,
    options: SdkCapabilityQueryOptions = sdkCapabilityQueryOptions(this.host.timer),
  ): Promise<BaseResult | null> {
    try {
      return (await this.ensureSdkCapability(capability, undefined, options))
        ? null
        : this.sdkUnavailableResult(capability);
    } catch (error) {
      if (error instanceof SdkCapabilityProbeSupersededError) {
        logger.warn(`[IOSCtrlProxyClient] ${error.message}`);
        return { success: false, totalTimeMs: 0, error: error.message };
      }
      throw error;
    }
  }

  isLegacySdkCommandSupported(capability: IosSdkCapability): boolean {
    return this.host.isCommandSupported(commandByCapability[capability]);
  }

  async requireSdkCapability(
    capability: IosSdkCapability,
    bundleId?: string,
    options: SdkCapabilityQueryOptions = sdkCapabilityQueryOptions(this.host.timer),
  ): Promise<void> {
    if (!(await this.ensureSdkCapability(capability, bundleId, options))) {
      throw new Error(this.sdkUnavailableResult(capability).error);
    }
  }
  /** Seed the known cache without exposing mutable client state. */
  seedForTesting(
    bundleId: string,
    capabilities: Iterable<IosSdkCapability>,
    observationBridge: IosObservationBridgeState = observationBridgeUnavailable("SDK_TOO_OLD"),
  ): void {
    this.sdkCapabilities = { bundleId, capabilities: new Set(capabilities), observationBridge };
    this.sdkCapabilitiesKnown = true;
  }
}
