import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingHttpHeaders } from "node:http";
import {
  DAEMON_RELEASED_SESSION_HEADER,
  DAEMON_SESSION_TOOL_BINDING_HEADER,
  DAEMON_TOOL_SELECTION_PROFILE_HEADER,
} from "../../src/daemon/constants";
import {
  buildMcpRequestContext,
  createStatelessMcpServer,
  refreshMcpResourceList,
  type McpForwardRequestContext,
} from "../../src/daemon/statelessMcpServerFactory";
import {
  isolateMcpServerFactoryForTesting,
  registerMcpServerFactory,
  type McpServerFactoryOptions,
} from "../../src/daemon/mcpServerFactoryPort";
import { daemonTaskLeaseKeepalive } from "../../src/daemon/tasks/daemonTaskManager";
import { createSdkMcpServer } from "../../src/server/sdkMcpServer";

const BOUND = "11111111-2222-4333-8444-555555555555";
const RELEASED = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const PROFILE = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

describe("daemon MCP factory port", () => {
  let server: ReturnType<typeof createSdkMcpServer>;
  beforeAll(() => {
    server = createSdkMcpServer({ name: "factory-port-test", version: "1.0.0" }, {});
  });
  // Another file sharing the process may have loaded src/server, which registers the real factory.
  let restoreFactory: () => void;
  beforeEach(() => {
    restoreFactory = isolateMcpServerFactoryForTesting();
  });
  afterEach(() => restoreFactory());

  test("fails clearly before registration and resource refresh is safe", async () => {
    expect(() =>
      createStatelessMcpServer({}, {}, { requestScopeId: "scope", requestMcpSessionId: "key" }),
    ).toThrow("The MCP server factory is not registered");
    await refreshMcpResourceList();
  });

  test("forwards request options and resolves late registrations and restores", async () => {
    const seen: McpServerFactoryOptions[] = [];
    let refreshed = 0;
    const restore = registerMcpServerFactory({
      createMcpServer: (options) => {
        seen.push(options);
        return server;
      },
      refreshMcpResourceList: async () => {
        refreshed++;
      },
    });
    try {
      expect(
        createStatelessMcpServer(
          { debug: true, acceptanceDiscoveryCapability: "capability" },
          { initialSessionToolBinding: BOUND },
          {
            requestScopeId: "scope",
            requestMcpSessionId: "key",
            trustedForwarder: true,
            taskOwnerKey: "proxy",
          },
        ),
      ).toBe(server);
      expect(seen).toEqual([
        {
          debug: true,
          acceptanceDiscoveryCapability: "capability",
          sessionContext: { initialSessionToolBinding: BOUND, sessionId: "scope" },
          daemonMode: true,
          requestMcpSessionId: "key",
          trustForwardedMcpSessionId: true,
          taskOwnerKey: "proxy",
          stateless: true,
          taskLeaseKeepalive: daemonTaskLeaseKeepalive(),
        },
      ]);
      const restoreNested = registerMcpServerFactory({
        createMcpServer: () => {
          throw new Error("nested factory");
        },
        refreshMcpResourceList: async () => {
          refreshed += 10;
        },
      });
      try {
        expect(() =>
          createStatelessMcpServer({}, {}, { requestScopeId: "scope", requestMcpSessionId: "key" }),
        ).toThrow("nested factory");
        await refreshMcpResourceList();
      } finally {
        restoreNested();
      }
      createStatelessMcpServer({}, {}, { requestScopeId: "direct", requestMcpSessionId: "key" });
      expect(seen[1].trustForwardedMcpSessionId).toBeUndefined();
      expect(seen[1].taskOwnerKey).toBeUndefined();
      await refreshMcpResourceList();
      expect(refreshed).toBe(11);
    } finally {
      restore();
    }
    expect(() =>
      createStatelessMcpServer({}, {}, { requestScopeId: "scope", requestMcpSessionId: "key" }),
    ).toThrow("The MCP server factory is not registered");
  });
});

/**
 * The headers the loopback HTTP client sends for a forward (#11820): a header only for a
 * non-empty value, with fetch's edge-whitespace normalization, as node:http hands them over.
 */
function sentHeaders(forward: McpForwardRequestContext): IncomingHttpHeaders {
  const headers = new Headers();
  if (forward.boundSessionUuid) {
    headers.set(DAEMON_SESSION_TOOL_BINDING_HEADER, forward.boundSessionUuid);
  }
  if (forward.releasedSessionUuid) {
    headers.set(DAEMON_RELEASED_SESSION_HEADER, forward.releasedSessionUuid);
  }
  if (forward.toolSelectionProfileUuid) {
    headers.set(DAEMON_TOOL_SELECTION_PROFILE_HEADER, forward.toolSelectionProfileUuid);
  }
  return Object.fromEntries(headers.entries());
}

describe("buildMcpRequestContext (#11820)", () => {
  const forwards: Array<[string, McpForwardRequestContext]> = [
    ["no context", {}],
    ["bound only", { boundSessionUuid: BOUND }],
    ["released only", { releasedSessionUuid: RELEASED }],
    ["profile only", { toolSelectionProfileUuid: PROFILE }],
    [
      "bound and a different released session",
      { boundSessionUuid: BOUND, releasedSessionUuid: RELEASED },
    ],
    ["bound session marked released", { boundSessionUuid: BOUND, releasedSessionUuid: BOUND }],
    [
      "bound session marked released with padding",
      { boundSessionUuid: ` ${BOUND}\t`, releasedSessionUuid: BOUND },
    ],
    [
      "all three",
      { boundSessionUuid: BOUND, releasedSessionUuid: RELEASED, toolSelectionProfileUuid: PROFILE },
    ],
    [
      "empty values",
      { boundSessionUuid: "", releasedSessionUuid: "", toolSelectionProfileUuid: "" },
    ],
    [
      "blank values",
      { boundSessionUuid: "  ", releasedSessionUuid: "\t", toolSelectionProfileUuid: " " },
    ],
    [
      "padded values",
      { boundSessionUuid: `  ${BOUND} `, toolSelectionProfileUuid: `\t${PROFILE}` },
    ],
  ];

  test.each(forwards)("a forward's struct and its loopback headers agree: %s", (_name, forward) => {
    expect(buildMcpRequestContext(forward)).toEqual(
      buildMcpRequestContext({ headers: sentHeaders(forward) }),
    );
  });

  test("a bound session the caller marked released is not bound", () => {
    expect(buildMcpRequestContext({ boundSessionUuid: BOUND, releasedSessionUuid: BOUND })).toEqual(
      { initialReleasedSession: BOUND },
    );
  });

  test("a repeated header (a string array) is not a context value", () => {
    expect(
      buildMcpRequestContext({ headers: { [DAEMON_SESSION_TOOL_BINDING_HEADER]: [BOUND, BOUND] } }),
    ).toEqual({});
  });

  test("all three fields reach the context", () => {
    expect(
      buildMcpRequestContext({
        boundSessionUuid: BOUND,
        releasedSessionUuid: RELEASED,
        toolSelectionProfileUuid: PROFILE,
      }),
    ).toEqual({
      initialSessionToolBinding: BOUND,
      initialReleasedSession: RELEASED,
      initialToolSelectionProfile: PROFILE,
    });
  });
});
