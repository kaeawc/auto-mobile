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

/**
 * Build the device-bound mock-rule payload from the current {@link NetworkState}.
 *
 * Single source of truth for the host → device mock-rule mapping shared by the
 * Android and iOS CtrlProxy clients (reconnect sync) and the `network` tool
 * (live sync). `remaining` is reinitialized from `limit` rather than copied from
 * the store: the server never tracks consumption, so the device-side
 * NetworkMockRuleStore must start each connection with fresh counts.
 */
export function buildNetworkMockRules(state: NetworkState): NetworkMockRuleSync[] {
  return Array.from(state.getMocks().values()).map((r: MockRule) => ({
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
