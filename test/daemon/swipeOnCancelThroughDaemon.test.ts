import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_CANCEL_REQUEST_METHOD, DAEMON_VERSION } from "../../src/daemon/constants";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * #10151: a client that cancels a long `swipeOn` `lookFor` search must stop the search before its
 * next swipe. This drives the whole hop chain in memory, with no listener, device, adb or daemon:
 *
 *   MCP client -> stdio proxy server -> DaemonClient -> daemon socket frames -> UnixSocketServer
 *     -> loopback MCP client `callTool` options.signal -> the tool's own swipe loop
 *
 * The tool is a recorder whose loop checks the signal exactly as the real search does: before each
 * swipe. The search loop's own abort checks are pinned in the ScrollUntilVisible and SwipeOn suites.
 */

class DaemonSideSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];
  /** Where frames the daemon writes are delivered (the client's read side). */
  deliver: (frame: string) => void = () => {};
  setTimeout(): this {
    return this;
  }
  write(data: string, callback?: (error?: Error | null) => void): boolean {
    this.responses.push(JSON.parse(data) as DaemonResponse);
    this.deliver(data);
    callback?.();
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close", false);
    return this;
  }
  receive(frame: string): void {
    this.emit("data", Buffer.from(frame));
  }
}

/** The client's write side: every frame the proxy writes reaches the daemon socket. */
class ClientSideSocket extends EventEmitter {
  destroyed = false;
  readonly frames: DaemonRequest[] = [];
  constructor(private readonly daemonSide: DaemonSideSocket) {
    super();
  }
  write(data: string): boolean {
    this.frames.push(JSON.parse(data) as DaemonRequest);
    this.daemonSide.receive(data);
    return true;
  }
  destroy(): this {
    this.destroyed = true;
    this.emit("close", false);
    return this;
  }
}

interface LoopbackCall {
  signal: AbortSignal | undefined;
  /** Swipes the fake search dispatched. */
  swipes: number;
  settled: Promise<unknown>;
}

interface Internals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
  getMcpClient(): Promise<Pick<Client, "callTool">>;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flush();
  }
}

describe("swipeOn lookFor cancellation through the daemon request path (#10151)", () => {
  let timer: FakeTimer;
  let internals: Internals;
  let daemonSide: DaemonSideSocket;
  let clientSide: ClientSideSocket;
  let daemonClient: DaemonClient;
  let loopbackCalls: LoopbackCall[];
  let nextSwipe: Array<() => void>;

  /**
   * One scripted swipe at a time: the search loop parks on `nextSwipe` between swipes, the way the
   * real one parks on the device, so the test decides exactly when the next swipe could happen.
   */
  const searchLoop = (signal: AbortSignal | undefined, call: LoopbackCall): Promise<never> =>
    (async () => {
      for (;;) {
        signal?.throwIfAborted();
        call.swipes++;
        await new Promise<void>((resolve) => nextSwipe.push(resolve));
      }
    })();

  const finishSwipe = async (): Promise<void> => {
    const release = nextSwipe.shift();
    release?.();
    await settle();
  };

  beforeEach(() => {
    timer = new FakeTimer();
    loopbackCalls = [];
    nextSwipe = [];
    const server = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      { isInitialized: () => false } as DaemonStateAccess,
      timer,
    );
    internals = server as unknown as Internals;
    internals.acceptingRequests = true;
    internals.getMcpClient = async () => ({
      callTool: (_params, _schema, options) => {
        const call: LoopbackCall = {
          signal: options?.signal,
          swipes: 0,
          settled: Promise.resolve(),
        };
        call.settled = searchLoop(options?.signal, call).catch((error: unknown) => error);
        loopbackCalls.push(call);
        return new Promise<never>((_resolve, reject) =>
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          }),
        );
      },
    });
    daemonSide = new DaemonSideSocket();
    clientSide = new ClientSideSocket(daemonSide);
    internals.handleConnection(daemonSide as unknown as Socket);
    daemonClient = new DaemonClient("/fake/socket", 60_000, timer, {}, null, new FakeIdGenerator());
    daemonClient.attachSocketForTesting(clientSide as never);
    daemonSide.deliver = (frame) => daemonClient.simulateIncomingDataForTesting(Buffer.from(frame));
  });

  afterEach(async () => {
    await daemonClient.close();
    daemonSide.destroy();
    await Promise.all([...internals.activeRequestHandlers]);
  });

  const lookForArgs = { direction: "up", lookFor: { text: "NeverAppears39" } };

  test("a cancel frame sent while the search is between swipes reaches the loopback signal and no swipe follows", async () => {
    const controller = new AbortController();
    const call = daemonClient
      .callTool("swipeOn", lookForArgs, undefined, undefined, controller.signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await settle();
    expect(loopbackCalls).toHaveLength(1);
    const [loopback] = loopbackCalls;
    await finishSwipe();
    await finishSwipe();
    expect(loopback.swipes).toBe(3);
    expect(loopback.signal?.aborted).toBe(false);

    controller.abort(new Error("client-cancel"));
    await settle();

    expect(clientSide.frames.map((frame) => frame.method)).toEqual([
      "tools/call",
      DAEMON_CANCEL_REQUEST_METHOD,
    ]);
    expect(clientSide.frames[1].params).toEqual({ requestId: clientSide.frames[0].id });
    expect(loopback.signal?.aborted).toBe(true);
    expect(((await call) as Error).message).toBe("client-cancel");

    // The search was parked mid-swipe; letting that swipe finish must not start another one.
    await finishSwipe();
    expect(loopback.swipes).toBe(3);
    expect(await loopback.settled).toBeInstanceOf(Error);
    expect(nextSwipe).toHaveLength(0);
  });

  test("an MCP cancellation notification from the client reaches the loopback signal through the stdio proxy", async () => {
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const fake = new FakeDaemonClient();
    fake.callTool = daemonClient.callTool.bind(daemonClient);
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => fake,
        daemonManager,
        timer,
        autoStartDaemon: false,
        daemonAvailabilityProbe: async () => true,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "cancel-test", version: "1" });
    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);
    try {
      const controller = new AbortController();
      const call = mcpClient
        .callTool({ name: "swipeOn", arguments: lookForArgs }, undefined, {
          signal: controller.signal,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await settle();
      expect(loopbackCalls).toHaveLength(1);
      await finishSwipe();
      expect(loopbackCalls[0].swipes).toBe(2);

      controller.abort(new Error("client-cancel"));
      await settle();

      expect(loopbackCalls[0].signal?.aborted).toBe(true);
      expect(clientSide.frames.map((frame) => frame.method)).toEqual([
        "tools/call",
        DAEMON_CANCEL_REQUEST_METHOD,
      ]);
      await finishSwipe();
      expect(loopbackCalls[0].swipes).toBe(2);
      expect(await call).toBeInstanceOf(Error);
    } finally {
      await mcpClient.close();
      await proxy.close();
    }
  });

  test("a cancel for one search leaves a second search on the same connection running", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const firstCall = daemonClient
      .callTool("swipeOn", lookForArgs, undefined, undefined, first.signal)
      .catch(() => undefined);
    const secondCall = daemonClient
      .callTool(
        "swipeOn",
        { ...lookForArgs, direction: "down" },
        undefined,
        undefined,
        second.signal,
      )
      .catch(() => undefined);
    await settle();
    // Same-device calls are admitted one at a time; the second waits behind the first.
    expect(loopbackCalls).toHaveLength(1);

    first.abort(new Error("client-cancel"));
    await settle();
    expect(loopbackCalls[0].signal?.aborted).toBe(true);
    expect(loopbackCalls).toHaveLength(2);
    expect(loopbackCalls[1].signal?.aborted).toBe(false);

    second.abort(new Error("client-cancel"));
    await Promise.all([firstCall, secondCall]);
  });
});
