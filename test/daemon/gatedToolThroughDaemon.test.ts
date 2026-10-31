import type { ForwardMcpClient } from "../../src/daemon/socketServer/forwardSessionKey";
import { ErrorCode, McpError } from "../../src/daemon/mcpError";
import { FakeSocket } from "../fakes/FakeNetServer";
import {
  createConnectableServer,
  uninitializedDaemonState,
} from "./helpers/ideMutationServerHarness";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import toolDefinitionsJson from "../../schemas/tool-definitions.json";
import { DaemonClient } from "../../src/daemon/client/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { DaemonMcpProxy, DaemonToolUnavailableError } from "../../src/daemon/daemonMcpProxy";
import { DAEMON_TOOL_UNAVAILABLE_CODE } from "../../src/daemon/types";
import { ToolUnavailableError } from "../../src/daemon/toolUnavailableError";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { ISOLATED_DAEMON_RECOVERY } from "../helpers/isolatedDaemonRecovery";

/**
 * #10179: nothing exercised the real hop chain for a gated tool. The proxy tests synthesise the
 * daemon error with `code` already set; this drives it end to end, in memory (no listener, device,
 * adb or daemon):
 *
 *   DaemonMcpProxy -> DaemonClient -> daemon socket frames -> UnixSocketServer
 *     -> loopback MCP client (rejects the way the SDK client rebuilds a gate rejection)
 *
 * The marker has to survive every hop, so a gated tool surfaces its gate reason without the proxy
 * resetting the shared client (which would abort the sibling install on the same connection).
 */

/** The client's end: every frame the proxy writes reaches the daemon socket. */
class ClientSideSocket extends Duplex {
  constructor(private readonly daemonSide: FakeSocket) {
    super();
  }

  override _read(): void {}

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.daemonSide.simulateData(chunk.toString());
    callback();
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await flush();
  }
}

// A debug-only tool the committed definitions say the frontend registers.
const gatedToolName = (
  toolDefinitionsJson as Array<{ name: string; _meta?: Record<string, unknown> }>
).find((tool) => tool._meta?.["automobile/debugOnly"] === true)!.name;
const GATE_REASON = "--debug is disabled; start the daemon with --debug";

describe("a gated tool through socket server, DaemonClient and proxy (#10179)", () => {
  let timer: FakeTimer;
  let server: ReturnType<typeof createConnectableServer>;
  let daemonSide: FakeSocket;
  let clientSide: ClientSideSocket;
  let daemonClient: DaemonClient;
  let proxy: DaemonMcpProxy;
  let clientFactoryCalls: number;
  let installStarted: PromiseWithResolvers<void>;
  let installRelease: PromiseWithResolvers<void>;
  const loopbackCalls: string[] = [];

  beforeEach(() => {
    timer = new FakeTimer();
    clientFactoryCalls = 0;
    loopbackCalls.length = 0;
    installStarted = Promise.withResolvers<void>();
    installRelease = Promise.withResolvers<void>();
    server = createConnectableServer("unused", uninitializedDaemonState(), timer);
    server.mcpClientFactory = async () => {
      const unused = async (): Promise<never> => {
        throw new Error("not exercised by this suite");
      };
      const loopback: ForwardMcpClient = {
        callTool: async (params: { name: string }) => {
          loopbackCalls.push(params.name);
          if (params.name === "installApp") {
            installStarted.resolve();
            await installRelease.promise;
            return { content: [{ type: "text" as const, text: "installed" }] };
          }
          // What the loopback MCP client rebuilds from the daemon server's JSON-RPC error:
          // the -32603 code, the unchanged text and the marker in `data`.
          const gate = new ToolUnavailableError(params.name, [GATE_REASON]);
          throw new McpError(ErrorCode.InternalError, gate.message, gate.data);
        },
        listTools: async () => ({ tools: [] }),
        listResources: unused,
        readResource: unused,
        listResourceTemplates: unused,
        request: unused,
        close: async () => {},
      };
      return loopback;
    };
    daemonSide = new FakeSocket();
    clientSide = new ClientSideSocket(daemonSide);
    server.connect(daemonSide);
    daemonClient = new DaemonClient("/fake/socket", 60_000, timer, {
      recoveryOptions: ISOLATED_DAEMON_RECOVERY,
      clientIdentity: null,
      idGenerator: new FakeIdGenerator(),
    });
    daemonClient.testHooks.attachSocket(clientSide);
    daemonSide.onWrite = (frame) => daemonClient.testHooks.simulateIncomingData(Buffer.from(frame));
    const manager = new FakeDaemonManager();
    manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
    proxy = new DaemonMcpProxy({
      clientFactory: () => {
        clientFactoryCalls++;
        return daemonClient;
      },
      daemonManager: manager,
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
      timer,
    });
  });

  afterEach(async () => {
    installRelease.resolve();
    await proxy.close();
    await daemonClient.close();
    daemonSide.destroy();
    await server.settleActiveHandlers();
  });

  test("the caller gets the gate reason, the shared client is not closed, and the sibling completes", async () => {
    // Different devices run in different admission lanes, so both are in flight at once.
    const install = proxy.callTool("installApp", {
      deviceId: "emulator-5554",
      apkPath: "/tmp/app.apk",
    });
    await installStarted.promise;

    const caught = await proxy.callTool(gatedToolName, { deviceId: "emulator-5556" }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The daemon marked the response, and the proxy surfaces the reason without a stale-daemon story.
    expect(
      daemonSide.responses.some((response) => response.code === DAEMON_TOOL_UNAVAILABLE_CODE),
    ).toBe(true);
    expect(caught).toBeInstanceOf(DaemonToolUnavailableError);
    expect((caught as DaemonToolUnavailableError).message).toContain(GATE_REASON);
    expect((caught as DaemonToolUnavailableError).message).not.toContain("Restart the daemon");
    expect((caught as DaemonToolUnavailableError).code).toBe(DAEMON_TOOL_UNAVAILABLE_CODE);

    // No reset: the one shared client is still connected and was never replaced.
    expect(clientSide.destroyed).toBe(false);
    expect(clientFactoryCalls).toBe(1);
    expect(loopbackCalls.filter((name) => name === gatedToolName)).toHaveLength(1);

    installRelease.resolve();
    await settle();
    await expect(install).resolves.toEqual({ content: [{ type: "text", text: "installed" }] });
  });
});
