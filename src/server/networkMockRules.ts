import { MockRule, NetworkState } from "./NetworkState";

/**
 * Wire shape for a single mock rule sent to a device's CtrlProxy over the
 * `set_network_mock_rules` message. Mirrors {@link MockRule} but is the
 * serialized contract — kept as its own type so the host-side serializer can
 * evolve independently of the in-memory store.
 */
export interface NetworkMockRuleSync {
  mockId: string;
  host: string;
  path: string;
  method: string;
  limit: number | null;
  remaining: number | null;
  statusCode: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  contentType: string;
}

/** A rule the device's own regex engine refused, with the device's reason (issue #10101). */
export interface RejectedMockRule {
  mockId: string;
  reason: string;
}

/**
 * What the device said about a pushed rule list. `unconfirmed`: the rules were sent but the device
 * reported nothing (an older SDK or runner, or no reply in time), so nothing is known to have been
 * skipped. `reported`: the device compiled the list and these are the rules it rejected.
 */
export type NetworkMockSyncReport =
  | { status: "unconfirmed" }
  | { status: "reported"; rejected: RejectedMockRule[] };

/** Outcome of pushing the rule list: handed to the device (with its report), or not delivered. */
export type NetworkMockPushResult =
  | { delivered: true; report: NetworkMockSyncReport }
  | { delivered: false; error: string };

/**
 * How long the host waits for the device's rejected-rule report. Only a delay when the device has
 * the report but is slow: a runner or SDK that never reports is detected without waiting.
 */
export const NETWORK_MOCK_REPORT_TIMEOUT_MS = 3000;

const NO_REASON = "no reason reported by the device";

/**
 * Read the device's rejected-rule report off a `set_network_mock_rules_result`. An absent
 * `rejectedMockIds` is "not reported", which is distinct from an empty list ("all installed").
 */
export function parseMockRuleReport(message: {
  rejectedMockIds?: unknown;
  rejectedReasons?: unknown;
}): NetworkMockSyncReport {
  const ids = message.rejectedMockIds;
  if (!Array.isArray(ids)) {
    return { status: "unconfirmed" };
  }
  const reasons: Record<string, unknown> =
    typeof message.rejectedReasons === "object" && message.rejectedReasons !== null
      ? (message.rejectedReasons as Record<string, unknown>)
      : {};
  const rejected = ids
    .filter((id): id is string => typeof id === "string")
    .map((mockId) => {
      const reason = reasons[mockId];
      return { mockId, reason: typeof reason === "string" ? reason : NO_REASON };
    });
  return { status: "reported", rejected };
}

/**
 * Build the device-bound mock-rule payload for ONE device from the current
 * {@link NetworkState} (issue #10061: a device only ever receives its own rules).
 *
 * Single source of truth for the host → device mock-rule mapping shared by the
 * Android and iOS CtrlProxy clients (reconnect sync) and the `network` tool
 * (live sync). `remaining` is the install-time count (`limit`): the server never
 * tracks consumption, and the device-side NetworkMockRuleStore keeps the live
 * count per `mockId` across a re-push (issue #10060), so a rule it already holds
 * is never re-armed by this value.
 */
export function buildNetworkMockRules(
  state: NetworkState,
  deviceId: string,
): NetworkMockRuleSync[] {
  return Array.from(state.getMocks(deviceId).values()).map((r: MockRule) => ({
    mockId: r.mockId,
    host: r.host,
    path: r.path,
    method: r.method,
    limit: r.limit,
    remaining: r.limit,
    statusCode: r.statusCode,
    responseHeaders: r.responseHeaders,
    responseBody: r.responseBody,
    contentType: r.contentType,
  }));
}
