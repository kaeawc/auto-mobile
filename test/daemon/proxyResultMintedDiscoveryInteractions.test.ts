import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import {
  DaemonClient,
  DaemonUnavailableError,
  type DaemonClientLike,
} from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

// Integration of three stdio-proxy changes that were each tested alone:
// the bound-session keeper fence (#9995), the not-delivered requireClient error
// (#9996) and unbound discovery after a result-minted release (#9997).

const STDIO_HEARTBEAT_TIMEOUT_MS = 10_000;
const FIRST_SESSION = "minted-session-a";
const SECOND_SESSION = "minted-session-b";

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

// Holds the notification opt-in at the end of doConnect open, so a test can close
// the socket after `connected` flipped but before establishment resolves.
class HeldSubscribeClient extends FakeDaemonClient {
  subscribeReached = false;
  private releaseSubscribe: () => void = () => {};
  private readonly subscribeGate = new Promise<void>((resolve) => {
    this.releaseSubscribe = resolve;
  });

  override async subscribeToNotifications(): Promise<void> {
    await super.subscribeToNotifications();
    this.subscribeReached = true;
    await this.subscribeGate;
  }

  closeSocketThenReleaseSubscribe(): void {
    this.emitConnectionClosed();
    this.releaseSubscribe();
  }
}

class RefusingClient extends FakeDaemonClient {
  override async connect(): Promise<void> {
    throw new DaemonUnavailableError("connection refused");
  }
}

async function waitForSubscribe(client: HeldSubscribeClient): Promise<void> {
  for (let turn = 0; turn < 200 && !client.subscribeReached; turn += 1) {
    await Promise.resolve();
  }
  expect(client.subscribeReached).toBe(true);
}

function heartbeats(client: FakeDaemonClient): number {
  return client.callDaemonMethodCalls.filter((call) => call.method === "daemon/heartbeat").length;
}

function listCalls(client: FakeDaemonClient): Array<{ method: string; params: unknown }> {
  return client.callDaemonMethodCalls.filter((call) => call.method.includes("list"));
}

function discoveryResults(): Map<string, unknown> {
  return new Map<string, unknown>([
    ["tools/list", { tools: [{ name: "getAndroid", inputSchema: { type: "object" } }] }],
    ["resources/list", { resources: [{ uri: "automobile:devices/booted", name: "booted" }] }],
    ["resources/list-templates", { resourceTemplates: [] }],
  ]);
}

function mintingClient(mintedSession: () => string): FakeDaemonClient {
  return new FakeDaemonClient({
    daemonMethodResults: discoveryResults(),
    toolResultFor: (toolName) =>
      toolName === "getAndroid"
        ? { content: [{ type: "text", text: JSON.stringify({ sessionId: mintedSession() }) }] }
        : undefined,
  });
}

describe("stdio proxy: keeper fence, not-delivered retry and result-minted discovery", () => {
  let isAvailableSpy: ReturnType<typeof spyOn> | undefined;
  let proxy: DaemonMcpProxy | undefined;

  afterEach(async () => {
    isAvailableSpy?.mockRestore();
    isAvailableSpy = undefined;
    await proxy?.close();
    proxy = undefined;
  });

  function createProxy(
    timer: FakeTimer,
    clients: DaemonClientLike[],
    fallback: () => DaemonClientLike,
  ): DaemonMcpProxy {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    proxy = new DaemonMcpProxy({
      clientFactory: () => clients.shift() ?? fallback(),
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      heartbeatTimeoutMs: STDIO_HEARTBEAT_TIMEOUT_MS,
      timer,
    });
    return proxy;
  }

  describe("(a) keeper reconnect hits the socket-closes-during-subscribe window", () => {
    test("a mid-subscribe close on the reconnect is retried and the session stays bound", async () => {
      const timer = new FakeTimer();
      const mint = mintingClient(() => FIRST_SESSION);
      const racing = new HeldSubscribeClient();
      const recovered = mintingClient(() => FIRST_SESSION);
      const target = createProxy(timer, [mint, racing, recovered], () => new RefusingClient());

      await target.callTool("getAndroid", {});
      mint.emitConnectionClosed();
      // At the stdio cadence the first tick is also the last safe attempt.
      const tick = timer.advanceTimeAsync(5_000);
      await waitForSubscribe(racing);
      racing.closeSocketThenReleaseSubscribe();
      await tick;

      // The never-written heartbeat was retried on the next client, not lost.
      expect(heartbeats(racing)).toBe(0);
      expect(heartbeats(recovered)).toBe(1);
      await expect(target.callTool("observe", {})).resolves.toBeDefined();
      expect(recovered.callToolCalls.at(-1)).toMatchObject({
        toolName: "observe",
        params: { sessionUuid: FIRST_SESSION },
      });
    });

    test("when every reconnect closes mid-subscribe the last safe attempt fences cleanly", async () => {
      const timer = new FakeTimer();
      const mint = mintingClient(() => FIRST_SESSION);
      const racingA = new HeldSubscribeClient();
      const racingB = new HeldSubscribeClient();
      const target = createProxy(timer, [mint, racingA, racingB], () => new RefusingClient());
      const listChanged: string[] = [];
      target.onListChanged((kind) => listChanged.push(kind));

      await target.callTool("getAndroid", {});
      listChanged.length = 0;
      mint.emitConnectionClosed();
      const tick = timer.advanceTimeAsync(5_000);
      await waitForSubscribe(racingA);
      racingA.closeSocketThenReleaseSubscribe();
      await waitForSubscribe(racingB);
      racingB.closeSocketThenReleaseSubscribe();
      await tick;

      expect(heartbeats(racingA) + heartbeats(racingB)).toBe(0);
      await expect(target.callTool("observe", {})).rejects.toMatchObject({
        reason: "heartbeat-unreachable",
      });
      // Result-minted fence: the client is prompted to re-list (#9997).
      expect(listChanged).toEqual(["tools"]);
    });
  });

  describe("(b) keeper fence of a result-minted session", () => {
    test("leaves discovery working unbound and sends tools/list_changed", async () => {
      const timer = new FakeTimer();
      const mint = mintingClient(() => FIRST_SESSION);
      const revived = mintingClient(() => FIRST_SESSION);
      let daemonUp = false;
      const target = createProxy(timer, [mint], () => (daemonUp ? revived : new RefusingClient()));
      const listChanged: string[] = [];
      target.onListChanged((kind) => listChanged.push(kind));

      await target.callTool("getAndroid", {});
      await target.listResources();
      listChanged.length = 0;
      mint.emitConnectionClosed();
      await timer.advanceTimeAsync(5_000);

      await expect(target.callTool("observe", {})).rejects.toMatchObject({
        reason: "heartbeat-unreachable",
      });
      expect(listChanged).toEqual(["tools"]);

      daemonUp = true;
      await expect(target.listTools()).resolves.toHaveLength(1);
      await expect(target.listResources()).resolves.toHaveLength(1);
      await expect(target.listResourceTemplates()).resolves.toEqual([]);
      expect(listCalls(revived)).toEqual([
        { method: "tools/list", params: {} },
        { method: "resources/list", params: {} },
        { method: "resources/list-templates", params: {} },
      ]);
    });
  });

  describe("(c) resource-list cache across release, unbound lists and rebinding", () => {
    test("release, unbound lists, then rebinding serves fresh resource lists for the new session", async () => {
      const timer = new FakeTimer();
      let minted = FIRST_SESSION;
      const client = mintingClient(() => minted);
      const target = createProxy(timer, [client], () => client);

      await target.callTool("getAndroid", {});
      await target.listResources();
      await target.listResourceTemplates();
      client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, FIRST_SESSION, "device-killed");

      client.callDaemonMethodCalls.length = 0;
      await target.listResources();
      await target.listResourceTemplates();
      // The release dropped the scoped cache and unbound lists are not cached, so
      // a repeat request goes to the daemon again.
      await target.listResources();
      await target.listResourceTemplates();
      expect(listCalls(client)).toEqual([
        { method: "resources/list", params: {} },
        { method: "resources/list-templates", params: {} },
        { method: "resources/list", params: {} },
        { method: "resources/list-templates", params: {} },
      ]);

      minted = SECOND_SESSION;
      await target.callTool("getAndroid", {});
      client.callDaemonMethodCalls.length = 0;
      await target.listResources();
      await target.listResourceTemplates();
      expect(listCalls(client)).toEqual([
        { method: "resources/list", params: { sessionUuid: SECOND_SESSION } },
        { method: "resources/list-templates", params: { sessionUuid: SECOND_SESSION } },
      ]);
    });

    test("re-acquiring over a live binding refetches resource lists under the new session", async () => {
      const timer = new FakeTimer();
      let minted = FIRST_SESSION;
      const client = mintingClient(() => minted);
      const target = createProxy(timer, [client], () => client);

      await target.callTool("getAndroid", {});
      await target.listResources();
      await target.listResourceTemplates();

      minted = SECOND_SESSION;
      await target.callTool("getAndroid", {});
      client.callDaemonMethodCalls.length = 0;
      await target.listResources();
      await target.listResourceTemplates();

      expect(listCalls(client)).toEqual([
        { method: "resources/list", params: { sessionUuid: SECOND_SESSION } },
        { method: "resources/list-templates", params: { sessionUuid: SECOND_SESSION } },
      ]);
    });

    test("binding after resource lists were cached unbound refetches them under the session", async () => {
      const timer = new FakeTimer();
      const client = mintingClient(() => FIRST_SESSION);
      const target = createProxy(timer, [client], () => client);

      await target.listResources();
      await target.listResourceTemplates();
      await target.callTool("getAndroid", {});
      client.callDaemonMethodCalls.length = 0;
      await target.listResources();
      await target.listResourceTemplates();

      expect(listCalls(client)).toEqual([
        { method: "resources/list", params: { sessionUuid: FIRST_SESSION } },
        { method: "resources/list-templates", params: { sessionUuid: FIRST_SESSION } },
      ]);
    });
  });
});
