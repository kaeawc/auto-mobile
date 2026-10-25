import { describe, expect, test } from "bun:test";
import { parseCallContext } from "../../../../src/server/pipeline/ingress/callContext";
import {
  INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
  INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_ONE_SHOT_CLI_PARAM,
  INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM,
} from "../../../../src/daemon/wire/constants";

const forwarded = {
  [INTERNAL_MCP_SESSION_PARAM]: "mcp-1",
  [INTERNAL_ONE_SHOT_CLI_PARAM]: true,
  [INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM]: true,
  [INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]: false,
  [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: 5000,
  [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: 123456,
  [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: "live-key",
  [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: "secret",
  [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: "reverse",
};

describe("parseCallContext", () => {
  test("reads every forwarded key on the daemon transport", () => {
    expect(
      parseCallContext(forwarded, { daemonMode: true, acceptanceDiscoveryCapability: "secret" }),
    ).toEqual({
      requestMcpSessionId: "mcp-1",
      requestOneShotCli: true,
      requestedToolResultsNoStructuredContent: true,
      requestedActionsCompactMetadata: false,
      requestTimeoutMs: 5000,
      requestDeadlineMs: 123456,
      requestLiveDeadlineKey: "live-key",
      requestAcceptanceDiscoveryOrder: "reverse",
    });
  });

  test("ignores forged keys when the server is not in daemon mode", () => {
    expect(
      parseCallContext(forwarded, { daemonMode: false, acceptanceDiscoveryCapability: "secret" }),
    ).toEqual({
      requestMcpSessionId: undefined,
      requestOneShotCli: false,
      requestedToolResultsNoStructuredContent: undefined,
      requestedActionsCompactMetadata: undefined,
      requestTimeoutMs: undefined,
      requestDeadlineMs: undefined,
      requestLiveDeadlineKey: undefined,
      requestAcceptanceDiscoveryOrder: undefined,
    });
  });

  test("rejects a wrong acceptance capability and malformed values", () => {
    const context = parseCallContext(
      {
        ...forwarded,
        [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: "wrong!",
        [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: -1,
        [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: Number.NaN,
        [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: "",
      },
      { daemonMode: true, acceptanceDiscoveryCapability: "secret" },
    );
    expect(context.requestAcceptanceDiscoveryOrder).toBeUndefined();
    expect(context.requestTimeoutMs).toBeUndefined();
    expect(context.requestDeadlineMs).toBeUndefined();
    expect(context.requestLiveDeadlineKey).toBeUndefined();
  });

  test("returns an empty context for non-object arguments", () => {
    const context = parseCallContext([], { daemonMode: true, acceptanceDiscoveryCapability: "x" });
    expect(context.requestMcpSessionId).toBeUndefined();
    expect(context.requestOneShotCli).toBe(false);
  });

  describe("session identity precedence (#13315)", () => {
    const inBand = { [INTERNAL_MCP_SESSION_PARAM]: "in-band" };
    const parse = (options: { sessionKey?: string; trustForwardedSessionId?: boolean }) =>
      parseCallContext(inBand, {
        daemonMode: true,
        acceptanceDiscoveryCapability: undefined,
        ...options,
      }).requestMcpSessionId;

    test("a direct request's session-key header wins over a conflicting in-band id", () => {
      expect(parse({ sessionKey: "header-key" })).toBe("header-key");
    });

    test("a trusted forwarder's in-band id wins over the connection key", () => {
      expect(parse({ sessionKey: "connection-key", trustForwardedSessionId: true })).toBe(
        "in-band",
      );
    });

    test("a header-less direct request still uses the in-band id", () => {
      expect(parse({})).toBe("in-band");
    });

    test("a call with no in-band id keeps the key as the binding key, not a context id", () => {
      for (const trustForwardedSessionId of [true, false]) {
        const context = parseCallContext(
          {},
          {
            daemonMode: true,
            acceptanceDiscoveryCapability: undefined,
            sessionKey: "key",
            trustForwardedSessionId,
          },
        );
        expect(context.requestMcpSessionId).toBeUndefined();
      }
    });

    test("outside daemon mode neither carrier is honoured", () => {
      expect(
        parseCallContext(inBand, {
          daemonMode: false,
          acceptanceDiscoveryCapability: undefined,
          sessionKey: "header-key",
        }).requestMcpSessionId,
      ).toBeUndefined();
    });
  });
});
