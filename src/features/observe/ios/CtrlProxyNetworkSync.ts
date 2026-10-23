import { toActionableError } from "../../../models/ActionableError";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import type { BootedDevice } from "../../../models";
import type { RequestManager } from "../../../utils/RequestManager";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { BaseResult } from "../shared/types";
import type { DelegateContext } from "./types";
import {
  sdkCapabilityQueryOptions,
  type SdkCapabilityQueryOptions,
  type CtrlProxySdkCapabilities,
} from "./CtrlProxySdkCapabilities";
import { sendCommand } from "../DeviceServiceUtils";
import { serverConfig } from "../../../utils/ServerConfig";
import {
  NetworkState,
  simulationRemainingMs,
  type SimulatedErrorType,
} from "../../../utils/NetworkState";
import {
  buildNetworkMockRules,
  NETWORK_MOCK_REPORT_TIMEOUT_MS,
  parseMockRuleReport,
  type NetworkMockSyncReport,
} from "../../../utils/networkMockRules";
import { logger } from "../../../utils/logger";
import { SdkCapabilityProbeSupersededError } from "./SdkCapabilityProbeSupersededError";
interface NetworkSyncHost {
  getDevice(): BootedDevice;
  readonly requestManager: RequestManager;
  readonly sdkCapability: Pick<
    CtrlProxySdkCapabilities,
    "hasSdkCapability" | "isLegacySdkCommandSupported" | "ensureSdkCapability" | "sdkCapabilityGate"
  >;
  sendMessage(data: string): boolean;
  isCommandSupported(messageType: string): boolean;
  createDelegateContext(): DelegateContext;
}

/**
 * Function type that returns currently booted devices.
 * Injected for testability — avoids coupling to PlatformDeviceManagerFactory in tests.
 */
/**
 * Result of pushing the mock-rule set to the iOS SDK: `sent` means the message
 * was written to the open connection; every other value means the rules were NOT
 * delivered (no network_mocking capability, mocking disabled, send failed, or the
 * capability probe was superseded by a newer foreground app).
 */
export type IosMockRuleSyncOutcome = "sent" | "noCapability" | "disabled" | "failed" | "superseded";

/**
 * [outcome] plus, when the rules were sent, what the runner said about them (#10101): the ids the
 * app's regex engine rejected, or `unconfirmed` when an older runner/SDK reported nothing or the
 * reply did not arrive in time.
 */
export interface IosMockRuleSyncResult {
  outcome: IosMockRuleSyncOutcome;
  report?: NetworkMockSyncReport;
}

/** The reshaped `set_network_mock_rules_result` (see decodeCtrlProxyMessage). */
interface IosMockRulesReply {
  success: boolean;
  rejectedMockIds?: string[];
  rejectedReasons?: Record<string, string>;
  /** Set by the host timeout: no reply within the bound. */
  timedOut?: true;
}

function interpretIosMockRulesReply(reply: IosMockRulesReply): IosMockRuleSyncResult {
  if (reply.timedOut) {
    return { outcome: "sent", report: { status: "unconfirmed" } };
  }
  if (!reply.success) {
    return { outcome: "failed" };
  }
  return { outcome: "sent", report: parseMockRuleReport(reply) };
}

export interface IosNetworkErrorSimulationConfig {
  enabled: boolean;
  errorType?: SimulatedErrorType | null;
  limit?: number | null;
  expiresAtEpochMs?: number | null;
  /** Time left, timed by the device's own monotonic clock; preferred over the epoch (#10062). */
  remainingMs?: number | null;
}
/** Capability-gated synchronization of this device's host network state. */
export class CtrlProxyNetworkSync {
  constructor(private readonly host: NetworkSyncHost) {}

  /**
   * Push THIS device's mock rules and error simulation from the host store.
   * Used after a session release clears the store (issue #10061); the
   * reconnect path runs the same two syncs. Rejects failed, noCapability or superseded
   * rule delivery and failed simulation writes so cleanup can mark a recording gap.
   * Sent rules (including unconfirmed replies) and disabled mocking succeed.
   * Simulation sync is always attempted, even when rule delivery fails.
   */
  public async syncNetworkStateFromHost(
    options: SdkCapabilityQueryOptions,
    // The client's own entry point, so its test seam still intercepts the rule sync.
    syncMockRules: (options: SdkCapabilityQueryOptions) => Promise<IosMockRuleSyncResult> = (
      opts,
    ) => this.syncNetworkMockRulesIfAvailable(opts),
  ): Promise<void> {
    let simulationDelivered = true;
    try {
      const result = await syncMockRules(options);
      if (["failed", "noCapability", "superseded"].includes(result.outcome)) {
        throw new Error(`Network mock rule sync ${result.outcome}`);
      }
    } catch (error) {
      logger.warn("[IOSCtrlProxyClient] Failed to sync network mock rules during cleanup", error);
      throw toActionableError(error, "iOS network mock rules were not delivered");
    } finally {
      // Always clear simulation; cleanup records a gap before containing delivery errors.
      simulationDelivered = this.syncNetworkErrorSimulationToDevice();
    }
    if (!simulationDelivered) {
      const error = new Error("Network error simulation sync failed");
      logger.warn("[IOSCtrlProxyClient] Failed to sync network simulation during cleanup", error);
      throw toActionableError(error, "iOS network error simulation was not delivered");
    }
  }

  /** Why the rules cannot be pushed at all right now, or null when they can. */
  private mockRuleSyncBlocker(): IosMockRuleSyncOutcome | null {
    if (
      !this.host.sdkCapability.hasSdkCapability("network_mocking") &&
      !this.host.sdkCapability.isLegacySdkCommandSupported("network_mocking")
    ) {
      return "noCapability";
    }
    if (!serverConfig.isNetworkMockableEnabled()) {
      return "disabled";
    }
    return null;
  }

  /**
   * Push the rules with a requestId and wait (bounded) for the runner's
   * `set_network_mock_rules_result`, which names the rules the app rejected (#10101). An older
   * runner replies without the field, and a late reply times out: both are `unconfirmed`, not a
   * failure. `ok:false` (the runner could not reach the SDK) is a failed push.
   */
  private async pushNetworkMockRulesToDevice(
    options: SdkCapabilityQueryOptions,
  ): Promise<IosMockRuleSyncResult> {
    const blocker = this.mockRuleSyncBlocker();
    if (blocker !== null) {
      return { outcome: blocker };
    }
    const context = this.host.createDelegateContext();
    const timeoutMs = Math.min(
      NETWORK_MOCK_REPORT_TIMEOUT_MS,
      options.deadlineMs === undefined
        ? Infinity
        : Math.max(0, options.deadlineMs - context.timer.now()),
    );
    if (options.abortSignal?.aborted || timeoutMs <= 0) {
      return { outcome: "failed" };
    }
    const requestId = this.host.requestManager.generateId("mockRules");
    try {
      const rules = buildNetworkMockRules(
        NetworkState.getInstance(),
        this.host.getDevice().deviceId,
      );
      const reply = this.host.requestManager.register<IosMockRulesReply>(
        requestId,
        "set_network_mock_rules_result",
        timeoutMs,
        (_id, _type, timeoutMs) => ({ success: false, timedOut: true, totalTimeMs: timeoutMs }),
      );
      // sendMessage returns false (and logs) when the socket is not open.
      if (
        !this.host.sendMessage(JSON.stringify({ type: "set_network_mock_rules", requestId, rules }))
      ) {
        this.host.requestManager.reject(
          requestId,
          new Error("set_network_mock_rules was not sent"),
        );
        return { outcome: "failed" };
      }
      return interpretIosMockRulesReply(
        await raceWithDeadline(reply, {
          timer: context.timer,
          signal: options.abortSignal,
          label: "Network mock rules",
        }),
      );
    } catch (e) {
      this.host.requestManager.reject(requestId, new Error("set_network_mock_rules send failed"));
      logger.warn(`[IOSCtrlProxyClient] Failed to push network mock rules: ${e}`);
      return { outcome: "failed" };
    } finally {
      this.host.requestManager.reject(requestId, new Error("Network mock rule sync ended"));
    }
  }

  syncNetworkMockRulesToDevice(): IosMockRuleSyncOutcome {
    const blocker = this.mockRuleSyncBlocker();
    if (blocker !== null) {
      return blocker;
    }

    try {
      // Always sync mock rules on reconnect. Sending an empty list clears
      // stale rules that may linger in the iOS SDK after a CtrlProxy restart.
      const rules = buildNetworkMockRules(
        NetworkState.getInstance(),
        this.host.getDevice().deviceId,
      );
      // sendMessage returns false (and logs) when the socket is not open.
      return this.host.sendMessage(JSON.stringify({ type: "set_network_mock_rules", rules }))
        ? "sent"
        : "failed";
    } catch (e) {
      logger.warn(`[IOSCtrlProxyClient] Failed to sync network mock rules on reconnect: ${e}`);
      return "failed";
    }
  }

  syncNetworkErrorSimulationToDevice(): boolean {
    if (
      !this.host.sdkCapability.hasSdkCapability("network_error_simulation") &&
      !this.host.sdkCapability.isLegacySdkCommandSupported("network_error_simulation")
    ) {
      return true;
    }
    if (!this.host.isCommandSupported("set_network_error_simulation")) {
      logger.info(
        "[IOSCtrlProxyClient] Skipping network error simulation sync; runner does not advertise set_network_error_simulation",
      );
      return true;
    }
    try {
      const sim = NetworkState.getInstance().getSimulation(this.host.getDevice().deviceId);
      if (sim === null) {
        return this.host.sendMessage(
          JSON.stringify({
            type: "set_network_error_simulation",
            enabled: false,
          }),
        );
      }
      const state = NetworkState.getInstance();
      return this.host.sendMessage(
        JSON.stringify({
          type: "set_network_error_simulation",
          enabled: true,
          errorType: sim.errorType,
          limit: sim.limit,
          expiresAtEpochMs: sim.expiresAt,
          // What is left now, so a reconnect cannot restart the original duration (#10062).
          remainingMs: simulationRemainingMs(sim, state.timer.now()),
        }),
      );
    } catch (e) {
      logger.warn(
        `[IOSCtrlProxyClient] Failed to sync network error simulation on reconnect: ${e}`,
      );
      return false;
    }
  }

  /**
   * Push the current mock rules to the app, reporting whether they were actually
   * delivered so `mockNetwork`/`clearMockNetwork` can warn like the Android path
   * (#9918) instead of claiming a sync that never happened.
   */
  public async syncNetworkMockRulesIfAvailable(
    options: SdkCapabilityQueryOptions = sdkCapabilityQueryOptions(
      this.host.createDelegateContext().timer,
    ),
  ): Promise<IosMockRuleSyncResult> {
    try {
      if (
        await this.host.sdkCapability.ensureSdkCapability("network_mocking", undefined, options)
      ) {
        return await this.pushNetworkMockRulesToDevice(options);
      }
      return { outcome: "noCapability" };
    } catch (error) {
      if (!(error instanceof SdkCapabilityProbeSupersededError)) {
        throw error;
      }
      // Safe to swallow: the generation that superseded this probe runs its own
      // refreshSdkCapabilitiesAndSync, which re-syncs the mock rules to the device.
      logger.debug(`[IOSCtrlProxyClient] mock-rule sync skipped: ${error.message}`);
      return { outcome: "superseded" };
    }
  }

  async setNetworkErrorSimulation(
    config: IosNetworkErrorSimulationConfig,
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
  ): Promise<BaseResult> {
    const options = sdkCapabilityQueryOptions(this.host.createDelegateContext().timer, timeoutMs);
    const gate = await this.host.sdkCapability.sdkCapabilityGate(
      "network_error_simulation",
      options,
    );
    if (gate !== null) {
      return gate;
    }
    return sendCommand<BaseResult>(this.host.createDelegateContext(), {
      idPrefix: "networkErrorSimulation",
      responseType: "set_network_error_simulation_result",
      messageType: "set_network_error_simulation",
      params: {
        enabled: config.enabled,
        errorType: config.errorType ?? null,
        limit: config.limit ?? null,
        expiresAtEpochMs: config.expiresAtEpochMs ?? null,
        remainingMs: config.remainingMs ?? null,
      },
      timeoutMs,
      ...options,
      perf,
      cancelScreenshotBackoff: false,
      errorLabel: "Network error simulation",
    });
  }
}
