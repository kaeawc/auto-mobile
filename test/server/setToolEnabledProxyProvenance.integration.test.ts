import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { createMcpServer } from "../../src/server/index";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerToolSelectionTools } from "../../src/server/toolSelectionTools";
import { InMemoryToolSelectionProfileRegistry } from "../../src/server/toolSelectionProfileRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * #6148 round 4 — the DEFAULT deployment forwards `setToolEnabled` through
 * `createProxyMcpServer` / `DaemonMcpProxy` / `src/daemon/socketServer.ts`,
 * not the direct server exercised by `setToolEnabledSessionValidation.integration.test.ts`.
 * That daemon-proxy loopback hop routes a mint call (no sessionUuid) and a
 * later explicit-sessionUuid reaffirm call through DIFFERENT internal client
 * keys (`sharedMcpForwardRoute` vs `sessionScopedForwardRoute` /
 * `toolSelectionProfileScopedForwardRoute` in socketServer.ts), each of which
 * gets its OWN `createMcpServer()`/`SessionToolBinding` instance. This test
 * models that split directly: two independent `createMcpServer()` instances
 * (standing in for the two internal loopback sessions socketServer.ts would
 * create) share ONE `toolSelectionProfileRegistry`, and a `FakeDaemonClient`
 * routes each simulated `tools/call` to whichever instance socketServer.ts
 * would actually pick, based on the exact same signal (whether the call
 * carries an explicit `sessionUuid`).
 */
describe("setToolEnabled through the daemon-proxy loopback hop (#6148 round 4)", () => {
  let sessionManager: SessionManager;
  let pool: DevicePool;
  let timer: FakeTimer;
  let isAvailableSpy: ReturnType<typeof spyOn> | null = null;
  let closeables: Array<{ close: () => Promise<void> }> = [];

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    pool = new DevicePool(sessionManager, "daemon-test", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([]);
    DaemonState.getInstance().initialize(sessionManager, pool);

    ToolRegistry.clearTools();
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ content: [{ type: "text" as const, text: "clipboard" }] }),
      { defaultEnabled: false },
    );
    registerToolSelectionTools();
  });

  afterEach(async () => {
    isAvailableSpy?.mockRestore();
    isAvailableSpy = null;
    for (const closeable of closeables) {
      await closeable.close();
    }
    closeables = [];
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    sessionManager.stopCleanupTimer();
  });

  /** Shared, in-memory tool-selection store standing in for the real daemon's
   * single SQLite-backed service — every internal loopback createMcpServer()
   * instance in production reads/writes the SAME persisted table, so the fakes
   * here must share ONE Map too, keyed like the real repository. */
  function makeSharedToolSelectionService() {
    const overrides = new Map<string, Map<string, boolean>>();
    return {
      isEnabled: async (
        sessionUuid: string | undefined,
        toolName: string,
        declaredDefault: boolean,
      ) => (sessionUuid ? overrides.get(sessionUuid)?.get(toolName) : undefined) ?? declaredDefault,
      getOverride: async (sessionUuid: string, toolName: string) =>
        overrides.get(sessionUuid)?.get(toolName),
      setEnabled: async (sessionUuid: string, toolName: string, enabled: boolean) => {
        const sessionOverrides = overrides.get(sessionUuid) ?? new Map<string, boolean>();
        sessionOverrides.set(toolName, enabled);
        overrides.set(sessionUuid, sessionOverrides);
      },
    };
  }

  /** One simulated internal loopback MCP session (what socketServer.ts spins up per distinct clientKey), backed by its own createMcpServer() instance but sharing the given registry AND tool-selection service. */
  async function makeLoopbackClient(
    sessionId: string,
    toolSelectionProfileRegistry: InMemoryToolSelectionProfileRegistry,
    sessionToolSelectionService: ReturnType<typeof makeSharedToolSelectionService>,
  ): Promise<Client> {
    const server = createMcpServer({
      daemonMode: true,
      sessionContext: { sessionId },
      toolSelectionProfileRegistry,
      sessionToolSelectionService,
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `loopback-${sessionId}`, version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push({ close: () => client.close() });
    return client;
  }

  /** Sets up createProxyMcpServer wired to a FakeDaemonClient that routes setToolEnabled calls to `sharedDefaultClient` (no sessionUuid) or `sessionScopedClient` (explicit sessionUuid) — exactly the split socketServer.ts's getToolsCallForwardRoute makes. */
  async function makeProxyClient(
    sharedDefaultClient: Client,
    sessionScopedClient: Client,
  ): Promise<Client> {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const fakeDaemonClient = new FakeDaemonClient({
      toolResultFor: (toolName, params) => {
        if (toolName !== "setToolEnabled") {
          return undefined;
        }
        const hasSessionUuid =
          typeof params.sessionUuid === "string" && params.sessionUuid.trim().length > 0;
        const target = hasSessionUuid ? sessionScopedClient : sharedDefaultClient;
        return target.request(
          { method: "tools/call", params: { name: "setToolEnabled", arguments: params } },
          z.any(),
        );
      },
    });
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => fakeDaemonClient,
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "proxy-test-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push({ close: () => client.close() });
    closeables.push({ close: () => proxy.close() });
    return client;
  }

  test("a genuinely server-issued profile update SUCCEEDS across the loopback hop", async () => {
    const sharedRegistry = new InMemoryToolSelectionProfileRegistry();
    const sharedService = makeSharedToolSelectionService();
    const sharedDefaultClient = await makeLoopbackClient(
      "internal-shared-default",
      sharedRegistry,
      sharedService,
    );
    const sessionScopedClient = await makeLoopbackClient(
      "internal-session-scoped",
      sharedRegistry,
      sharedService,
    );
    const proxyClient = await makeProxyClient(sharedDefaultClient, sessionScopedClient);

    // 1) Omit sessionUuid — routes to the "shared default" internal session,
    // which mints and records a fresh profile.
    const mintResult = (await proxyClient.request(
      {
        method: "tools/call",
        params: { name: "setToolEnabled", arguments: { toolName: "clipboard", enabled: true } },
      },
      z.any(),
    )) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    expect(mintResult.isError ?? false).toBe(false);
    const mintedProfileUuid = JSON.parse(
      mintResult.content?.find((c) => c.type === "text")?.text ?? "{}",
    ).sessionUuid as string;
    expect(typeof mintedProfileUuid).toBe("string");
    expect(mintedProfileUuid.length).toBeGreaterThan(0);

    // 2) Explicitly reaffirm that SAME profile — routes to the DIFFERENT,
    // session-scoped internal instance, which never locally minted it. Must
    // still succeed because the registry is shared across both instances.
    const reaffirmResult = (await proxyClient.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: { toolName: "clipboard", enabled: false, sessionUuid: mintedProfileUuid },
        },
      },
      z.any(),
    )) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

    expect(reaffirmResult.isError ?? false).toBe(false);
    const reaffirmText = reaffirmResult.content?.find((c) => c.type === "text")?.text ?? "";
    expect(JSON.parse(reaffirmText)).toMatchObject({
      sessionUuid: mintedProfileUuid,
      toolName: "clipboard",
      enabled: false,
    });
  });

  test("a fabricated profile-only identifier is REJECTED across the loopback hop", async () => {
    const sharedRegistry = new InMemoryToolSelectionProfileRegistry();
    const sharedService = makeSharedToolSelectionService();
    const sharedDefaultClient = await makeLoopbackClient(
      "internal-shared-default-2",
      sharedRegistry,
      sharedService,
    );
    const sessionScopedClient = await makeLoopbackClient(
      "internal-session-scoped-2",
      sharedRegistry,
      sharedService,
    );
    const proxyClient = await makeProxyClient(sharedDefaultClient, sessionScopedClient);

    const result = (await proxyClient.request(
      {
        method: "tools/call",
        params: {
          name: "setToolEnabled",
          arguments: {
            toolName: "clipboard",
            enabled: true,
            sessionUuid: "attacker-fabricated-profile-uuid",
          },
        },
      },
      z.any(),
    )) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };

    // The proxy's generic CallTool handler converts a thrown daemon-side error
    // into an isError result rather than rejecting the outer request.
    expect(result.isError).toBe(true);
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("is not an active daemon session");
  });
});
