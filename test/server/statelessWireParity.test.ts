import { FakeDaemonHttpTokenStore } from "../../src/daemon/FakeDaemonHttpTokenStore";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { DaemonClient } from "../../src/daemon/client";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { DAEMON_VERSION, MCP_STREAMABLE_PATH } from "../../src/daemon/constants";
import { registerMcpTools } from "../../src/server";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { Client } from "@modelcontextprotocol/client";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createFakeDeviceManager } from "../daemon/helpers/inputSocketHarness";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";

/*
 * Wire-contract baseline for the MCP SDK v2 / stateless-daemon migration (mcpv2 slice G).
 *
 * Everything asserted here is what an EXTERNAL client observes, so it must hold both before and
 * after the daemon's streamable-HTTP endpoint becomes stateless:
 *   1. `tools/list` through the proxy, as serialized on the wire, equals
 *      schemas/tool-definitions.json (filtered to the default-enabled surface), byte for byte.
 *   2. The desktop app's handshake (initialize -> notifications/initialized -> requests) against
 *      the REAL daemon `/auto-mobile/streamable` handler produces the answers checked into
 *      test/fixtures/desktop-wire/stateless-handshake.json. The `mcp-session-id` response header is
 *      deliberately not part of the fixture: McpHttpClient only echoes it when the server sends
 *      one, so the contract is "works with or without it".
 *
 * Regenerate the fixture after an intended change:
 *   UPDATE_CAPTURED_FIXTURES=1 bun test test/server/statelessWireParity.test.ts
 * The Kotlin suite McpHttpClientStatelessTest replays the same fixture with a server that never
 * returns a session id.
 */

const FIXTURE_PATH = join(
  import.meta.dir,
  "..",
  "fixtures",
  "desktop-wire",
  "stateless-handshake.json",
);
const TOOL_DEFINITIONS_PATH = join(import.meta.dir, "..", "..", "schemas", "tool-definitions.json");

/** Frames exactly as AutoMobileClient.kt buildInitializeParams / McpHttpClient send them. */
const DESKTOP_FRAMES: Array<{ label: string; body: Record<string, unknown> }> = [
  {
    label: "initialize",
    body: {
      jsonrpc: "2.0",
      id: "desktop-handshake-1",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "auto-mobile-desktop", version: "0.0.0-fixture" },
      },
    },
  },
  {
    label: "initialized",
    body: { jsonrpc: "2.0", method: "notifications/initialized" },
  },
  { label: "ping", body: { jsonrpc: "2.0", id: "desktop-handshake-2", method: "ping" } },
  {
    label: "prompts-list",
    body: { jsonrpc: "2.0", id: "desktop-handshake-3", method: "prompts/list" },
  },
];

interface FixtureExchange {
  label: string;
  request: Record<string, unknown>;
  response: { status: number; message: unknown };
}

interface HandshakeFixture {
  scenario: string;
  description: string;
  exchanges: FixtureExchange[];
}

isolateToolRegistry();

beforeEach(() => {
  // Keep device discovery off the host's adb/simctl: the handshake needs no devices.
  PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([]));
});

afterEach(() => {
  PlatformDeviceManagerFactory.reset();
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 0;
}

/** The JSON-RPC message in a JSON or `text/event-stream` body (keepalives/priming skipped). */
function messageOf(body: string): unknown {
  if (body.trim().length === 0) {
    return null;
  }
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((data) => data.length > 0);
  return JSON.parse(dataLines.length > 0 ? dataLines.join("\n") : body) as unknown;
}

/** serverInfo.version tracks the package version; the contract is its shape, not its value. */
function normalize(message: unknown): unknown {
  const text = JSON.stringify(message ?? null).replaceAll(DAEMON_VERSION, "<daemon-version>");
  const parsed = JSON.parse(text) as { result?: { serverInfo?: { version?: string } } } | null;
  if (parsed?.result?.serverInfo?.version) {
    parsed.result.serverInfo.version = "<server-version>";
  }
  return parsed;
}

/** The `tools` array of the first `tools/list` result frame the server sent. */
function listToolsFrameTools(sent: JSONRPCMessage[]): unknown[] {
  for (const message of sent) {
    if ("result" in message && Array.isArray(message.result.tools)) {
      return message.result.tools;
    }
  }
  throw new Error("no tools/list result frame was sent");
}

describe("tools/list through the proxy matches schemas/tool-definitions.json", () => {
  interface CommittedTool {
    name: string;
    description?: string;
    inputSchema: unknown;
    _meta?: Record<string, unknown>;
  }
  // Parsing the committed catalog and registering every tool are one-time setup; the single test
  // below clears the registry afterwards, so beforeAll (outside the 100 ms budget) is enough.
  let committed: CommittedTool[];
  let expectedNames: string[];
  beforeAll(() => {
    registerMcpTools(false);
    committed = JSON.parse(readFileSync(TOOL_DEFINITIONS_PATH, "utf8")) as CommittedTool[];
    const defaultEnabled = new Map(
      ToolRegistry.getAllTools({ includeUnavailable: true }).map((tool) => [
        tool.name,
        tool.defaultEnabled ?? true,
      ]),
    );
    expectedNames = committed
      .filter((tool) => defaultEnabled.get(tool.name) ?? true)
      .map((tool) => tool.name);
  });

  /*
   * Before a daemon connection the proxy serves the committed file's cold-start projection
   * (staticToolDefinitions.ts): the default-enabled tools with name, description, inputSchema and
   * `_meta` (minus the internal gating keys), and NO outputSchema. Those fields are compared as
   * serialized bytes against the committed entry.
   */
  const GATING_META_KEYS = [
    "automobile/debugOnly",
    "automobile/embeddedSdkOnly",
    "automobile/planOnly",
  ];

  test("the wire frame carries the committed definitions byte for byte", async () => {
    expect(expectedNames.length).toBeGreaterThan(0);

    const availability = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => new FakeDaemonClient(),
        daemonManager: new FakeDaemonManager(),
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const sent: JSONRPCMessage[] = [];
    const originalSend = serverTransport.send.bind(serverTransport);
    serverTransport.send = async (message, options) => {
      sent.push(message);
      return originalSend(message, options);
    };
    const client = new Client({ name: "wire-parity-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();

      const tools = listToolsFrameTools(sent);
      const served = tools as Array<{
        name: string;
        description?: string;
        inputSchema: unknown;
        outputSchema?: unknown;
        _meta?: Record<string, unknown>;
      }>;
      expect(served.map((tool) => tool.name)).toEqual(expectedNames);
      for (const tool of served) {
        const source = committed.find((candidate) => candidate.name === tool.name)!;
        const meta = Object.fromEntries(
          Object.entries(source._meta ?? {}).filter(([key]) => !GATING_META_KEYS.includes(key)),
        );
        expect(tool.outputSchema).toBeUndefined();
        expect(JSON.stringify(tool.inputSchema)).toBe(JSON.stringify(source.inputSchema));
        expect(tool.description).toBe(source.description);
        expect(JSON.stringify(tool._meta ?? {})).toBe(JSON.stringify(meta));
      }
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
      availability.mockRestore();
    }
  });
});

describe("desktop handshake against the real daemon streamable endpoint", () => {
  async function captureHandshake(): Promise<HandshakeFixture> {
    const port = await freePort();
    const daemon = new Daemon(
      { port, host: "127.0.0.1" },
      {
        timer: new FakeTimer(),
        httpToken: "test-http-token",
        httpTokenStore: new FakeDaemonHttpTokenStore(),
      },
    );
    // The HTTP listener lifecycle is private; Daemon.start() would also boot devices and the DB.
    const call = async (method: string): Promise<void> => {
      await Reflect.get(daemon, method).call(daemon);
    };
    daemon.testHooks.publishHttpToken();
    await Reflect.get(daemon, "httpIngress").start();
    await call("resolveStartupCompletion");
    await Promise.resolve();

    const exchanges: FixtureExchange[] = [];
    let sessionId: string | null = null;
    try {
      for (const frame of DESKTOP_FRAMES) {
        const headers: Record<string, string> = {
          authorization: "Bearer test-http-token",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        };
        // McpHttpClient echoes the session header only when the server handed one back.
        if (sessionId) {
          headers["mcp-session-id"] = sessionId;
        }
        const response = await fetch(`http://127.0.0.1:${port}${MCP_STREAMABLE_PATH}`, {
          method: "POST",
          headers,
          body: JSON.stringify(frame.body),
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        exchanges.push({
          label: frame.label,
          request: frame.body,
          response: {
            status: response.status,
            message: normalize(messageOf(await response.text())),
          },
        });
      }
    } finally {
      await Reflect.get(daemon, "httpIngress").closeListener();
    }
    return {
      scenario: "stateless-handshake",
      description:
        "initialize, notifications/initialized, ping and prompts/list as the desktop McpHttpClient " +
        "sends them, answered by the real Daemon streamable-HTTP handler. The mcp-session-id " +
        "response header and the body framing (JSON vs event stream) are not recorded: the client " +
        "echoes the header only when present and decodes either framing.",
      exchanges,
    };
  }

  // One handshake against a real HTTP listener serves both tests: the first capture pays the cold
  // listener start (about 110 ms on a Linux runner), so it runs in beforeAll, outside the 100 ms
  // budget (#11574).
  let captured: HandshakeFixture;
  beforeAll(async () => {
    // beforeAll runs before the file's beforeEach, so install the same host-free device manager.
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([]));
    try {
      captured = await captureHandshake();
    } finally {
      PlatformDeviceManagerFactory.reset();
    }
  });

  test("answers match the checked-in fixture", () => {
    if (process.env.UPDATE_CAPTURED_FIXTURES === "1") {
      writeFileSync(FIXTURE_PATH, `${JSON.stringify(captured, null, 2)}\n`);
    }
    if (!existsSync(FIXTURE_PATH)) {
      throw new Error(
        `Missing ${FIXTURE_PATH}; generate it with UPDATE_CAPTURED_FIXTURES=1 bun test ${import.meta.path}`,
      );
    }
    expect(captured).toEqual(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as HandshakeFixture);
  });

  test("the legacy initialize is answered with a negotiated protocol version", () => {
    const init = captured.exchanges[0].response;
    expect(init.status).toBe(200);
    const result = (init.message as { result: { protocolVersion: string } }).result;
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(captured.exchanges[1].response.status).toBe(202);
  });
});
