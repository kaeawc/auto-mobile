import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client/client";
import { DAEMON_CANCEL_REQUEST_METHOD, DAEMON_VERSION } from "../../src/daemon/wire/constants";
import type { DaemonRequest } from "../../src/daemon/types";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { NonThrowingFakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { StubMcpClient } from "./helpers/fakeMcpClient";
import {
  createHarnessServer,
  type UnixSocketServerHarness,
} from "./helpers/UnixSocketServerHarness";
import { ISOLATED_DAEMON_RECOVERY } from "../helpers/isolatedDaemonRecovery";
import { daemonRequestFrameSchema } from "../helpers/wireMessageSchemas";

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

class DaemonSideSocket extends NonThrowingFakeSocket {
  /** Where frames the daemon writes are delivered (the client's read side). */
  deliver: (frame: string) => void = () => {};
  write(buffer: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  write(
    str: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (err?: Error | null) => void,
  ): boolean;
  write(
    data: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean {
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    const accepted = super.write(data, callback);
    this.deliver(typeof data === "string" ? data : Buffer.from(data).toString());
    return accepted;
  }
  receive(frame: string): void {
    this.simulateData(frame);
  }
}

/** The client's write side: every frame the proxy writes reaches the daemon socket. */
class ClientSideSocket extends NonThrowingFakeSocket {
  constructor(private readonly daemonSide: DaemonSideSocket) {
    super();
  }
  /** The request frames the client wrote, in order. */
  get frames(): DaemonRequest[] {
    return this.getWrittenMessages(daemonRequestFrameSchema);
  }
  write(buffer: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  write(
    str: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (err?: Error | null) => void,
  ): boolean;
  write(
    data: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    maybeCallback?: (error?: Error | null) => void,
  ): boolean {
    const callback = typeof encodingOrCallback === "function" ? encodingOrCallback : maybeCallback;
    const accepted = super.write(data, callback);
    this.daemonSide.receive(typeof data === "string" ? data : Buffer.from(data).toString());
    return accepted;
  }
}

interface LoopbackCall {
  signal: AbortSignal | undefined;
  /** Swipes the fake search dispatched. */
  swipes: number;
  settled: Promise<unknown>;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await flush();
  }
}

async function connectProxy(fake: FakeDaemonClient, timer: FakeTimer) {
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
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
  return { server, proxy, mcpClient };
}

describe("swipeOn lookFor cancellation through the daemon request path (#10151)", () => {
  let timer: FakeTimer;
  let internals: UnixSocketServerHarness;
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

  beforeAll(async () => {
    // Pay the SDK's first connection/schema initialization outside test timing. This throwaway
    // connection is closed; the cancellation test still builds its own client and proxy.
    const { server, proxy, mcpClient } = await connectProxy(
      new FakeDaemonClient(),
      new FakeTimer(),
    );
    await mcpClient.close();
    await server.close();
    await proxy.close();
  });

  beforeEach(() => {
    timer = new FakeTimer();
    loopbackCalls = [];
    nextSwipe = [];
    internals = createHarnessServer(
      "unused",
      { ...createFakeDaemonState(), isInitialized: () => false },
      timer,
    );
    internals.allowRequests();
    internals.mcpClientFactory = async () =>
      new StubMcpClient({
        callTool: (_params, options) => {
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
    internals.connect(daemonSide);
    daemonClient = new DaemonClient("/fake/socket", 60_000, timer, ISOLATED_DAEMON_RECOVERY, {
      clientIdentity: null,
      idGenerator: new FakeIdGenerator(),
    });
    daemonClient.testHooks.attachSocket(clientSide);
    daemonSide.deliver = (frame) => daemonClient.testHooks.simulateIncomingData(Buffer.from(frame));
  });

  afterEach(async () => {
    await daemonClient.close();
    daemonSide.destroy();
    await Promise.all([...internals.state.activeRequestHandlers]);
  });

  const lookForArgs = { direction: "up", lookFor: { text: "NeverAppears39" } };

  test("a cancel frame sent while the search is between swipes reaches the loopback signal and no swipe follows", async () => {
    const controller = new AbortController();
    const call = daemonClient
      .callTool("swipeOn", lookForArgs, undefined, undefined, { signal: controller.signal })
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
    const failure = await call;
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty("message", "client-cancel");

    // The search was parked mid-swipe; letting that swipe finish must not start another one.
    await finishSwipe();
    expect(loopback.swipes).toBe(3);
    expect(await loopback.settled).toBeInstanceOf(Error);
    expect(nextSwipe).toHaveLength(0);
  });

  test("an MCP cancellation notification from the client reaches the loopback signal through the stdio proxy", async () => {
    const fake = new FakeDaemonClient();
    fake.callTool = daemonClient.callTool.bind(daemonClient);
    const { server, proxy, mcpClient } = await connectProxy(fake, timer);
    try {
      const controller = new AbortController();
      const call = mcpClient
        .callTool(
          { name: "swipeOn", arguments: lookForArgs },
          {
            signal: controller.signal,
          },
        )
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
      await server.close();
      await proxy.close();
    }
  });

  test("a cancel for one search leaves a second search on the same connection running", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const firstCall = daemonClient
      .callTool("swipeOn", lookForArgs, undefined, undefined, { signal: first.signal })
      .catch(() => undefined);
    const secondCall = daemonClient
      .callTool("swipeOn", { ...lookForArgs, direction: "down" }, undefined, undefined, {
        signal: second.signal,
      })
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
