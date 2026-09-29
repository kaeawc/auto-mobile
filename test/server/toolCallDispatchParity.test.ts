import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod/v4";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION, INTERNAL_EXECUTION_ID_PARAM } from "../../src/daemon/constants";
import { ActionableError } from "../../src/models";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { errorMessage } from "../../src/utils/describeUnknownError";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { McpTestFixture } from "../fixtures/mcpTestFixture";

/**
 * Issue #6545: every `tools/call` entry point installs the one shared dispatch
 * envelope, so a call produces the same outcome whichever door it came in by.
 *
 * - direct: `createMcpServer()` as a stdio/in-memory client reaches it.
 * - daemon loopback: `createMcpServer({ daemonMode: true })`, the server the
 *   daemon forwards to.
 * - proxy: `createProxyMcpServer()`, forwarding over a fake daemon client into
 *   the daemon loopback server.
 *
 * The proxy reports a daemon-side failure as an `isError` tool result by
 * contract (`resolveCallToolErrorResult`), where the servers answer with a
 * JSON-RPC error, so outcomes are compared as (isError, message) rather than
 * by transport envelope.
 */

const OK_TOOL = "__dispatch_parity_ok__";
const FAIL_TOOL = "__dispatch_parity_fail__";
const UNKNOWN_TOOL = "__dispatch_parity_unknown__";
const DECLARED_SESSION_TOOL = "__dispatch_parity_declared_session__";

interface Outcome {
  isError: boolean;
  text: string;
}

type CallEntryPoint = (name: string, args: Record<string, unknown>) => Promise<Outcome>;

// Strip the transport framing each door adds: the SDK's `MCP error <code>: `
// prefix on a JSON-RPC error, and the proxy's `Error: ` on a forwarded failure.
// The proxy client also re-words an unknown tool as `Unknown tool "<name>".`
// (`DaemonMcpProxy.toolUnavailableError`, which can append a removed-tool
// hint); that happens before dispatch, so map it to the servers' wording.
function normalizeMessage(message: string): string {
  return message
    .replace(/^Error: /, "")
    .replace(/^MCP error -?\d+: /, "")
    .replace(/^Unknown tool "([^"]+)"\.$/, "Unknown tool: $1");
}

function firstText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const first: unknown = content[0];
  return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
}

async function callThrough(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Outcome> {
  try {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      text: normalizeMessage(firstText(result.content)),
    };
  } catch (error) {
    return { isError: true, text: normalizeMessage(errorMessage(error)) };
  }
}

// Forwards a proxied call to the daemon loopback server, the way the real
// socket server forwards over its internal MCP client.
class ForwardingDaemonClient extends FakeDaemonClient {
  constructor(private readonly daemonServerClient: () => Client) {
    super({ daemonMethodResults: new Map([["tools/list", { tools: [] }]]) });
  }

  override async callTool(
    toolName: string,
    params: Record<string, unknown>,
    progressToken?: string | number,
    onRequestId?: (requestId: string) => void,
  ): Promise<unknown> {
    await super.callTool(toolName, params, progressToken, onRequestId);
    return this.daemonServerClient().callTool({ name: toolName, arguments: params });
  }
}

describe("tools/call entry points share one dispatcher (issue #6545)", () => {
  const direct = new McpTestFixture();
  const daemonLoopback = new McpTestFixture({ daemonMode: true });
  let proxyClient: Client;
  let closeProxy: () => Promise<void>;
  let isAvailableSpy: ReturnType<typeof spyOn> | undefined;
  const handlerArgs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    ToolRegistry.register(
      OK_TOOL,
      "parity probe that succeeds",
      z.object({ count: z.number() }).strict(),
      async (args: Record<string, unknown>) => {
        handlerArgs.push(args);
        return { content: [{ type: "text", text: `count=${String(args.count)}` }] };
      },
    );
    ToolRegistry.register(FAIL_TOOL, "parity probe that fails", z.object({}), async () => {
      throw new ActionableError("parity probe failed");
    });
    ToolRegistry.register(
      DECLARED_SESSION_TOOL,
      "parity probe that declares sessionUuid",
      z.object({ sessionUuid: z.string(), count: z.number() }).strict(),
      async (args: Record<string, unknown>) => {
        handlerArgs.push(args);
        return { content: [{ type: "text", text: `session=${String(args.sessionUuid)}` }] };
      },
    );
    await direct.setup();
    await daemonLoopback.setup();

    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const daemonClient = new ForwardingDaemonClient(() => daemonLoopback.client);
    const { server } = createProxyMcpServer({
      proxyConfig: { clientFactory: () => daemonClient, daemonManager, autoStartDaemon: false },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    proxyClient = new Client({ name: "dispatch-parity-proxy-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await proxyClient.connect(clientTransport);
    closeProxy = async () => {
      await proxyClient.close();
      await server.close();
    };
    // Warm each door once so no row pays a cold-start cost.
    await callThrough(proxyClient, OK_TOOL, { count: 0 });
    await callThrough(direct.client, OK_TOOL, { count: 0 });
  });

  afterEach(() => {
    handlerArgs.length = 0;
  });

  afterAll(async () => {
    await closeProxy?.();
    await daemonLoopback.teardown();
    await direct.teardown();
    isAvailableSpy?.mockRestore();
    ToolRegistry.unregister(OK_TOOL);
    ToolRegistry.unregister(FAIL_TOOL);
    ToolRegistry.unregister(DECLARED_SESSION_TOOL);
  });

  const entryPoints: Array<[string, CallEntryPoint]> = [
    ["direct", (name, args) => callThrough(direct.client, name, args)],
    ["daemon loopback", (name, args) => callThrough(daemonLoopback.client, name, args)],
    ["proxy", (name, args) => callThrough(proxyClient, name, args)],
  ];

  const cases: Array<{
    label: string;
    name: string;
    args: Record<string, unknown>;
    expected: (outcome: Outcome) => void;
  }> = [
    {
      label: "success",
      name: OK_TOOL,
      args: { count: 3 },
      expected: (outcome) => expect(outcome).toEqual({ isError: false, text: "count=3" }),
    },
    {
      label: "tool error",
      name: FAIL_TOOL,
      args: {},
      expected: (outcome) =>
        expect(outcome).toEqual({ isError: true, text: "parity probe failed" }),
    },
    {
      label: "unknown tool",
      name: UNKNOWN_TOOL,
      args: {},
      expected: (outcome) =>
        expect(outcome).toEqual({ isError: true, text: `Unknown tool: ${UNKNOWN_TOOL}` }),
    },
    {
      label: "invalid params",
      name: OK_TOOL,
      args: { count: "three" },
      expected: (outcome) => {
        expect(outcome.isError).toBe(true);
        expect(outcome.text).toStartWith(`Invalid parameters for tool ${OK_TOOL}:`);
      },
    },
  ];

  test.each(cases)("$label: every entry point returns the same outcome", async (row) => {
    const outcomes: Outcome[] = [];
    for (const [, call] of entryPoints) {
      outcomes.push(await call(row.name, row.args));
    }

    row.expected(outcomes[0]);
    expect(outcomes).toEqual(outcomes.map(() => outcomes[0]));
  });

  test("the live direct handler is the full dispatcher, not the SDK per-tool callback", async () => {
    await callThrough(direct.client, OK_TOOL, { count: 1 });

    // Only the shared dispatcher's backend stamps the execution id; the SDK's
    // per-tool callback (shadowed) would have refused the call instead.
    expect(handlerArgs).toHaveLength(1);
    expect(typeof handlerArgs[0][INTERNAL_EXECUTION_ID_PARAM]).toBe("string");
  });

  test("undeclared sessionUuid is stripped before strict validation on every entry point", async () => {
    for (const [, call] of entryPoints) {
      const outcome = await call(OK_TOOL, { count: 1, sessionUuid: "" });
      expect(outcome).toEqual({ isError: false, text: "count=1" });
    }
    expect(handlerArgs).toHaveLength(entryPoints.length);
    expect(handlerArgs.every((args) => !("sessionUuid" in args))).toBe(true);
  });

  test("sessionUuid declared by a strict tool reaches its handler", async () => {
    for (const [, call] of entryPoints) {
      const outcome = await call(DECLARED_SESSION_TOOL, {
        count: 1,
        sessionUuid: "",
      });
      expect(outcome).toEqual({ isError: false, text: "session=" });
    }
    expect(handlerArgs).toHaveLength(entryPoints.length);
    expect(handlerArgs.every((args) => args.sessionUuid === "")).toBe(true);
  });

  test("unrelated unknown keys remain rejected", async () => {
    for (const [, call] of entryPoints) {
      const outcome = await call(OK_TOOL, { count: 1, sessionUuid: "", bogusKey: true });
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toContain('Unrecognized key: "bogusKey"');
    }
  });
});
