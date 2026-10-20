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
}

interface IosSdkCapabilitiesResult extends BaseResult {
  available?: boolean;
  probeError?: SdkCapabilityQueryError;
  unsupported?: boolean;
  bundleId?: string;
  capabilities?: string[];
}
type SdkCapabilityProbeResult =
  | { status: "capabilities"; capabilities: IosSdkCapabilities }
  | { status: "unavailable" }
  | { status: "unknown"; error: SdkCapabilityQueryError };

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

  private async refreshSdkCapabilities(): Promise<SdkCapabilityProbeResult> {
    if (!this.host.isCommandSupported("get_sdk_capabilities")) {
      this.sdkCapabilities = null;
      this.sdkCapabilitiesKnown = true;
      return { status: "unavailable" };
    }

    const generation = this.sdkCapabilityGeneration;
    if (this.sdkCapabilityRefreshInFlight?.generation === generation) {
      return this.sdkCapabilityRefreshInFlight.promise;
    }

    const promise = this.requestSdkCapabilities(generation);
    const inFlight = { generation, promise };
    this.sdkCapabilityRefreshInFlight = inFlight;
    void promise
      .finally(() => {
        if (this.sdkCapabilityRefreshInFlight === inFlight) {
          this.sdkCapabilityRefreshInFlight = null;
        }
      })
      .catch((error) => {
        // The caller handles the rejection; this branch prevents an unhandled promise rejection.
        logger.debug(`[IOSCtrlProxyClient] SDK capability refresh cleanup: ${errorMessage(error)}`);
      });
    return promise;
  }

  async requestSdkCapabilities(generation: number): Promise<SdkCapabilityProbeResult> {
    let result = await this.sendSdkCapabilityQuery();
    // This read is safe to retry, but never re-probe an invalidated foreground generation.
    if (result.probeError?.code === "timeout" && generation === this.sdkCapabilityGeneration) {
      result = await this.sendSdkCapabilityQuery();
    }
    if (result.probeError) {
      return { status: "unknown", error: result.probeError };
    }
    if (result.unsupported) {
      return { status: "unavailable" };
    }
    return this.cacheSdkCapabilityReply(generation, result);
  }

  private cacheSdkCapabilityReply(
    generation: number,
    result: IosSdkCapabilitiesResult,
  ): SdkCapabilityProbeResult {
    if (
      !result.success ||
      result.available === undefined ||
      (result.available && !result.bundleId)
    ) {
      return {
        status: "unknown",
        error: new SdkCapabilityQueryError(
          "sdk_capability_query_failed",
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
          }
        : null;

    if (generation === this.sdkCapabilityGeneration) {
      this.sdkCapabilities = capabilities;
      this.sdkCapabilitiesKnown = true;
      this.sdkCapabilitiesKnownAt = this.host.timer.now();
    } else {
      return {
        status: "unknown",
        error: new SdkCapabilityQueryError(
          "sdk_capability_query_failed",
          "SDK capability query superseded by a newer foreground state; re-observe and retry.",
        ),
      };
    }
    return capabilities ? { status: "capabilities", capabilities } : { status: "unavailable" };
  }

  private async sendSdkCapabilityQuery(): Promise<IosSdkCapabilitiesResult> {
    try {
      return await sendCommand<IosSdkCapabilitiesResult>(this.host.createDelegateContext(), {
        idPrefix: "sdkCapabilities",
        responseType: "sdk_capabilities",
        messageType: "get_sdk_capabilities",
        timeoutMs: IOS_HIERARCHY_REQUEST_TIMEOUT_MS,
        cancelScreenshotBackoff: false,
        errorLabel: "SDK capability query",
        notConnectedError: () => ({
          success: false,
          totalTimeMs: 0,
          probeError: new SdkCapabilityQueryError(
            "not_connected",
            "SDK capability query not connected to CtrlProxy",
          ),
        }),
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
      });
    } catch (error) {
      // Socket loss/send failures reject the request rather than using a fallback builder.
      const message = errorMessage(error);
      logger.warn(`[IOSCtrlProxyClient] SDK capability query failed: ${message}`, error);
      return {
        success: false,
        totalTimeMs: 0,
        probeError: new SdkCapabilityQueryError(
          message === WEBSOCKET_NOT_CONNECTED_MESSAGE || message === "WebSocket connection closed"
            ? "not_connected"
            : "sdk_capability_query_failed",
          `SDK capability query failed: ${message}`,
          { cause: error },
        ),
      };
    }
  }

  async refreshSdkCapabilitiesAndSync(): Promise<void> {
    const capabilities = await this.refreshSdkCapabilities();
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

  async ensureSdkCapability(capability: IosSdkCapability, bundleId?: string): Promise<boolean> {
    if (!this.host.getSupportedCommands()?.has("get_sdk_capabilities")) {
      return this.isLegacySdkCommandSupported(capability);
    }
    if (this.sdkCapabilitiesKnown) {
      if (
        this.sdkCapabilities === null &&
        this.host.timer.now() - this.sdkCapabilitiesKnownAt >=
          CtrlProxySdkCapabilities.SDK_CAPABILITY_NEGATIVE_CACHE_TTL_MS
      ) {
        this.sdkCapabilitiesKnown = false;
      } else {
        return this.hasSdkCapability(capability, bundleId);
      }
    }
    // Generation binding (#6896): the waiter records the generation it was created
    // under and decides ONLY from that generation's probe result. A hierarchy update
    // can invalidate this generation and complete a replacement probe for another
    // foreground app before this probe answers; rereading the shared cache here
    // would let that app's capabilities authorize this waiter.
    const probeGeneration = this.sdkCapabilityGeneration;
    const probed = await this.refreshSdkCapabilities();
    if (probeGeneration !== this.sdkCapabilityGeneration) {
      throw new SdkCapabilityProbeSupersededError(
        capability,
        probeGeneration,
        this.sdkCapabilityGeneration,
      );
    }
    if (probed.status === "unknown") {
      throw probed.error;
    }
    return CtrlProxySdkCapabilities.capabilitiesInclude(
      probed.status === "capabilities" ? probed.capabilities : null,
      capability,
      bundleId,
    );
  }

  /**
   * Result-returning variant of `ensureSdkCapability` for callers that report
   * failures as a `BaseResult` instead of throwing: `null` means the capability
   * is available; otherwise the actionable failure to return as-is.
   */
  async sdkCapabilityGate(capability: IosSdkCapability): Promise<BaseResult | null> {
    try {
      return (await this.ensureSdkCapability(capability))
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

  async requireSdkCapability(capability: IosSdkCapability, bundleId?: string): Promise<void> {
    if (!(await this.ensureSdkCapability(capability, bundleId))) {
      throw new Error(this.sdkUnavailableResult(capability).error);
    }
  }
  /** Seed the known cache without exposing mutable client state. */
  seedForTesting(bundleId: string, capabilities: Iterable<IosSdkCapability>): void {
    this.sdkCapabilities = { bundleId, capabilities: new Set(capabilities) };
    this.sdkCapabilitiesKnown = true;
  }
}
