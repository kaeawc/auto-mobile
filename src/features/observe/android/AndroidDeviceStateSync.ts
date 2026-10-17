/**
 * Pushes host-held device state to the CtrlProxy runner on every (re)connect: this device's network
 * mock rules and error simulation, and the accessibility flag configuration. Extracted from
 * `AndroidCtrlProxyClient` (#11846); behaviour is unchanged.
 */
import { NetworkState, simulationRemainingMs } from "../../../server/NetworkState";
import { buildNetworkMockRules } from "../../../server/networkMockRules";
import { logger } from "../../../utils/logger";
import { serverConfig } from "../../../utils/ServerConfig";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";

export interface AndroidDeviceStateSyncContext {
  readonly deviceId: string;
  /** Returns false when the frame could not be sent. */
  sendMessage(message: string): boolean;
}

export class AndroidDeviceStateSync {
  constructor(private readonly context: AndroidDeviceStateSyncContext) {}

  /**
   * Push THIS device's mock rules and error simulation from the host store.
   * Runs on every (re)connect, and after a session release clears the store so
   * the device drops what that session installed (issue #10061).
   */
  syncNetworkState(): void {
    try {
      const state = NetworkState.getInstance();
      const deviceId = this.context.deviceId;

      // Always sync mock rules on reconnect, scoped to this device. The device
      // store keeps consumption per mockId across a re-push (#10060). Sending an
      // empty list clears stale rules that may linger from a previous connection.
      const rules = buildNetworkMockRules(state, deviceId);
      this.context.sendMessage(
        serializeCtrlProxyRequest(ctrlProxyRequests.setNetworkMockRules({ rules })),
      );

      // Always re-sync error simulation state (including disabled) so the
      // device doesn't keep stale simulation config from a previous connection
      const sim = state.getSimulation(deviceId);
      this.context.sendMessage(
        serializeCtrlProxyRequest(
          ctrlProxyRequests.setNetworkErrorSimulation({
            enabled: sim !== null,
            errorType: sim?.errorType,
            limit: sim?.limit,
            expiresAtEpochMs: sim?.expiresAt,
            // What is left now, not the original duration: the device times it on its own
            // monotonic clock, so a skewed device clock cannot stretch or kill it (#10062).
            remainingMs: sim ? simulationRemainingMs(sim, state.timer.now()) : undefined,
          }),
        ),
      );
    } catch (e) {
      logger.debug(`[AndroidCtrlProxyClient] Failed to sync network state on reconnect: ${e}`);
    }
  }

  syncAccessibilityFlags(): void {
    try {
      const flags = serverConfig.getAccessibilityFlagsConfig();
      const allEnabled =
        flags.includeNotImportantViews &&
        flags.reportViewIds &&
        flags.retrieveInteractiveWindows &&
        flags.occlusionEnabled;
      // Diagnostic: without this, "did the push ever get attempted" is unanswerable from
      // logs alone — the only prior signal was the (info-level) send below, so a no-op
      // skip and "never called" were indistinguishable (issue occlusion-flag).
      logger.debug(
        `[AndroidCtrlProxyClient] syncAccessibilityFlagsToDevice invoked: allEnabled=${allEnabled}, ` +
          `occlusionEnabled=${flags.occlusionEnabled}`,
      );
      if (allEnabled) {
        return;
      }

      logger.info(
        `[AndroidCtrlProxyClient] Sending accessibility flags config: ` +
          `includeNotImportantViews=${flags.includeNotImportantViews}, ` +
          `reportViewIds=${flags.reportViewIds}, ` +
          `retrieveInteractiveWindows=${flags.retrieveInteractiveWindows}, ` +
          `occlusionEnabled=${flags.occlusionEnabled}`,
      );
      this.context.sendMessage(
        serializeCtrlProxyRequest(
          ctrlProxyRequests.setAccessibilityFlags({
            includeNotImportantViews: flags.includeNotImportantViews,
            reportViewIds: flags.reportViewIds,
            retrieveInteractiveWindows: flags.retrieveInteractiveWindows,
            occlusionEnabled: flags.occlusionEnabled,
          }),
        ),
      );
    } catch (e) {
      logger.debug(
        `[AndroidCtrlProxyClient] Failed to sync accessibility flags on reconnect: ${e}`,
      );
    }
  }
}
