import type { NetworkMockPushResult, NetworkMockRuleSync } from "../../../server/networkMockRules";
import {
  NETWORK_MOCK_REPORT_TIMEOUT_MS,
  parseMockRuleReport,
} from "../../../server/networkMockRules";
import { sendCommand } from "../DeviceServiceUtils";
import type { BaseResult } from "../shared/types";
import type { DelegateContext } from "./types";
import { NETWORK_MOCK_RULES_REPORT_CAPABILITY } from "./ctrlProxyProtocol";

interface MockRulesWireResult extends BaseResult {
  rejectedMockIds?: string[];
  rejectedReasons?: Record<string, string>;
  /** Set by sendCommand when the connected runner does not advertise the report capability. */
  unsupportedCapability?: string;
  /** Dispatched, but no `set_network_mock_rules_result` arrived within the bound. */
  timedOut?: true;
}

const UNCONFIRMED: NetworkMockPushResult = {
  delivered: true,
  report: { status: "unconfirmed" },
};

function interpret(result: MockRulesWireResult): NetworkMockPushResult {
  if (result.timedOut) {
    return UNCONFIRMED;
  }
  if (!result.success) {
    return { delivered: false, error: result.error ?? "set_network_mock_rules failed" };
  }
  return { delivered: true, report: parseMockRuleReport(result) };
}

/**
 * Push the device's rule list and wait (bounded) for the rules its regex engine rejected (#10101).
 *
 * A CtrlProxy that does not advertise {@link NETWORK_MOCK_RULES_REPORT_CAPABILITY} is sent the
 * plain fire-and-forget message via [sendLegacy]; a missing or late reply, and an SDK that does not
 * report, all resolve to `unconfirmed` (sent, device did not say) rather than a failure.
 */
export async function pushNetworkMockRules(
  context: DelegateContext,
  rules: NetworkMockRuleSync[],
  sendLegacy: () => boolean,
  timeoutMs: number = NETWORK_MOCK_REPORT_TIMEOUT_MS,
): Promise<NetworkMockPushResult> {
  const result = await sendCommand<MockRulesWireResult>(context, {
    idPrefix: "mockRules",
    responseType: "set_network_mock_rules_result",
    messageType: "set_network_mock_rules",
    params: { rules },
    timeoutMs,
    cancelScreenshotBackoff: false,
    requireExistingConnection: true,
    requiredCapability: NETWORK_MOCK_RULES_REPORT_CAPABILITY,
    errorLabel: "Network mock rules",
    notConnectedError: () => ({ success: false, totalTimeMs: 0, error: "Not connected" }),
    timeoutError: (timeout) => ({ success: false, totalTimeMs: timeout, timedOut: true }),
    unsupportedCommandError: (_type, error) => ({ success: false, totalTimeMs: 0, error }),
  });
  if (result.unsupportedCapability) {
    return sendLegacy()
      ? UNCONFIRMED
      : { delivered: false, error: "The device connection is not open" };
  }
  return interpret(result);
}
