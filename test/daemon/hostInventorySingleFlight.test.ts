import { DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM } from "../../src/daemon/wire/constants";
import { describe, expect, test } from "bun:test";
import { fakeBindLock, unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { StubMcpClient } from "./helpers/fakeMcpClient";
import { currentForwardSessionKey } from "../../src/daemon/socketServer/forwardSessionKey";
import { McpTimeoutError } from "../../src/daemon/wire/McpTimeoutError";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import { FakeSocket } from "../fakes/FakeNetServer";
import type { McpForwardContext } from "../../src/daemon/socketServerParts/socketServerContracts";

function harness() {
  const timer = new FakeTimer();
  const server = new UnixSocketServerHarness(
    "unused",
    createFakeDaemonState(),
    timer,
    undefined,
    { mcpDispatcher: unreachableMcpDispatcher },
    undefined,
    { bindLock: fakeBindLock },
  );
  let discoveries = 0;
  const pending: Array<ReturnType<typeof Promise.withResolvers<{ content: [] }>>> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const scopes: Array<string | undefined> = [];
  const budgets: Array<number | undefined> = [];
  server.mcpClientFactory = async () => {
    scopes.push(currentForwardSessionKey());
    return new StubMcpClient({
      callTool: (_params, options) => {
        discoveries++;
        signals.push(options?.signal);
        budgets.push(options?.timeout);
        const gate = Promise.withResolvers<{ content: [] }>();
        pending.push(gate);
        return gate.promise;
      },
    });
  };
  function context(
    args: Record<string, unknown> = { platform: "ios" },
    name = "listDevices",
    signal?: AbortSignal,
  ): McpForwardContext {
    return {
      request: {
        id: `r${discoveries}`,
        type: "mcp_request",
        method: "tools/call",
        params: { name, arguments: args },
      },
      socketSessionId: `sock${discoveries}`,
      route: { executionKey: "host:inventory", clientKey: "host:inventory" },
      totalTimeoutMs: 1000,
      deadline: new ProgressExtendableDeadline(timer.now(), 1000),
      signal,
    };
  }
  return {
    server,
    timer,
    pending,
    signals,
    scopes,
    budgets,
    context,
    discoveries: () => discoveries,
  };
}

function waitForDiscoveries(h: ReturnType<typeof harness>, count: number) {
  return drainUntil(() => h.discoveries() >= count, {
    description: `${count} discoveries started`,
  });
}

function succeed(h: ReturnType<typeof harness>) {
  for (const gate of h.pending) {
    gate.resolve({ content: [] });
  }
}

describe("host inventory single-flight", () => {
  test.each(["listDevices", "listDeviceImages"])(
    "%s shares discovery across sockets and refreshes after completion",
    async (name) => {
      const h = harness();
      const original =
        name === "listDevices"
          ? { platform: "ios", requires: { panels: 2, posture: "opened" } }
          : { platform: "ios" };
      const reordered =
        name === "listDevices"
          ? { requires: { posture: "opened", panels: 2 }, platform: "ios" }
          : { platform: "ios" };
      const calls = Array.from({ length: 5 }, (_, index) =>
        h.server.forwardRequest({
          ...h.context(
            {
              ...original,
              [DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM]: `owner-${index}`,
            },
            name,
          ),
          socketSessionId: `sock-${index}`,
        }),
      );
      calls.push(h.server.forwardRequest(h.context(reordered, name)));
      await waitForDiscoveries(h, 1);
      succeed(h);
      const results = await Promise.all(calls);
      expect(h.discoveries()).toBe(1);
      expect(results.every((result) => result === results[0])).toBe(true);
      const later = h.server.forwardRequest(h.context(reordered, name));
      await waitForDiscoveries(h, 2);
      succeed(h);
      await later;
      expect(h.discoveries()).toBe(2);
    },
  );

  test("different platforms, tools, arguments and profiles run separately", async () => {
    const h = harness();
    const contexts = [
      h.context(),
      h.context({ platform: "android" }),
      h.context({ platform: "ios", requires: { panels: 2 } }),
      h.context({ platform: "ios" }, "listDeviceImages"),
      {
        ...h.context(),
        route: {
          executionKey: "host:inventory",
          clientKey: "profile",
          toolSelectionProfileUuid: "profile",
        },
      },
    ];
    const calls = contexts.map((context) => h.server.forwardRequest(context));
    await waitForDiscoveries(h, contexts.length);
    succeed(h);
    await Promise.all(calls);
    expect(h.discoveries()).toBe(5);
  });

  test("bound sockets sharing a profile join the same inventory flight", async () => {
    const h = harness();
    const calls = ["held-a", "held-b"].map((sessionUuid) =>
      h.server.forwardRequest({
        ...h.context(),
        socketSessionId: sessionUuid,
        route: {
          executionKey: "host:inventory",
          clientKey: sessionUuid,
          sessionUuid,
          toolSelectionProfileUuid: "shared-profile",
        },
      }),
    );
    await waitForDiscoveries(h, 1);
    succeed(h);
    await Promise.all(calls);
    expect(h.discoveries()).toBe(1);
  });

  test("shares errors without poisoning the next discovery", async () => {
    const h = harness();
    const calls = [h.server.forwardRequest(h.context()), h.server.forwardRequest(h.context())];
    const settled = Promise.allSettled(calls);
    await waitForDiscoveries(h, 1);
    const error = new Error("discovery failed");
    for (const gate of h.pending) {
      gate.reject(error);
    }
    const answers = await settled;
    expect(h.discoveries()).toBe(1);
    expect(answers).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
    const later = h.server.forwardRequest(h.context());
    await waitForDiscoveries(h, 2);
    succeed(h);
    await later;
    expect(h.discoveries()).toBe(2);
  });

  test.each(["abort", "timeout"])("one waiter's %s leaves shared discovery alive", async (mode) => {
    const h = harness();
    const controller = new AbortController();
    const first = h.server.forwardRequest(h.context(undefined, undefined, controller.signal));
    const firstResult = Promise.allSettled([first]);
    const secondContext = h.context();
    secondContext.deadline = new ProgressExtendableDeadline(h.timer.now(), 10_000);
    secondContext.totalTimeoutMs = 10_000;
    const second = h.server.forwardRequest(secondContext);
    await waitForDiscoveries(h, 1);
    if (mode === "abort") {
      controller.abort(new Error("caller left"));
    } else {
      h.timer.advanceTime(1001);
    }
    const firstAnswers = await firstResult;
    const stillAlive = h.signals.every((signal) => !signal?.aborted);
    succeed(h);
    await second;
    expect(firstAnswers[0].status).toBe("rejected");
    expect(stillAlive).toBe(true);
    expect(h.scopes[0]).toStartWith("host:inventory:");
    expect(h.discoveries()).toBe(1);
  });

  test("host listings enter forwarding concurrently on one socket", async () => {
    const h = harness();
    const socket = new FakeSocket();
    h.server.allowRequests();
    h.server.connect(socket);
    const sessionId = h.server.sessionIds[0];
    const contexts = [h.context(), h.context({ platform: "android" })];
    const calls = contexts.map((context, index) =>
      h.server.dispatchRequest(
        sessionId,
        socket,
        { ...context.request, id: `listing-${index}` },
        h.timer.now(),
      ),
    );
    await waitForDiscoveries(h, 2);
    succeed(h);
    await Promise.all(calls);
    expect(h.discoveries()).toBe(2);
  });

  test.each(["startDevice", "killDevice"])(
    "a listing admitted after %s does not join an older flight",
    async (tool) => {
      const h = harness();
      const first = h.server.forwardRequest(h.context());
      await waitForDiscoveries(h, 1);
      const socket = new FakeSocket();
      h.server.allowRequests();
      h.server.connect(socket);
      const sessionId = h.server.sessionIds[0];
      const barrierStarted = Promise.withResolvers<void>();
      const barrierDone = Promise.withResolvers<unknown>();
      h.server.localRequestHandler = async (request) => {
        if (request.params?.name === tool) {
          barrierStarted.resolve();
          return await barrierDone.promise;
        }
        return undefined;
      };
      const barrier = h.server.dispatchRequest(
        sessionId,
        socket,
        h.context({}, tool).request,
        h.timer.now(),
      );
      await barrierStarted.promise;
      const later = h.server.dispatchRequest(sessionId, socket, h.context().request, h.timer.now());
      barrierDone.resolve({});
      await barrier;
      // No clock tick: ordering must distinguish the barrier even within one millisecond.
      await waitForDiscoveries(h, 2);
      // Finishing the older flight cannot evict the still-running newer one.
      h.pending[0].resolve({ content: [] });
      await first;
      const joined = h.server.forwardRequest(h.context());
      const fresh: { content: [] } = { content: [] };
      h.pending[1].resolve(fresh);
      expect(await later).toMatchObject({ success: true, result: fresh });
      expect(await joined).toBe(fresh);
      expect(h.discoveries()).toBe(2);
    },
  );

  test.each([
    ["listDevices", "startDevice"],
    ["listDevices", "killDevice"],
    ["listDeviceImages", "startDevice"],
    ["listDeviceImages", "killDevice"],
  ])("%s on a new socket refreshes after %s on another socket", async (name, tool) => {
    const h = harness();
    h.server.allowRequests();
    const socketA = new FakeSocket();
    h.server.connect(socketA);
    const first = h.server.dispatchRequest(
      h.server.sessionIds[0],
      socketA,
      h.context({}, name).request,
      h.timer.now(),
    );
    await waitForDiscoveries(h, 1);

    const socketB = new FakeSocket();
    h.server.connect(socketB);
    h.server.localRequestHandler = async (request) =>
      request.params?.name === tool ? {} : undefined;
    expect(
      await h.server.dispatchRequest(
        h.server.sessionIds[1],
        socketB,
        h.context({}, tool).request,
        h.timer.now(),
      ),
    ).toMatchObject({ success: true });

    // C has never admitted a barrier; B's completion must still invalidate A's flight.
    // No fake clock tick separates the requests.
    const socketC = new FakeSocket();
    h.server.connect(socketC);
    const later = h.server.dispatchRequest(
      h.server.sessionIds[2],
      socketC,
      h.context({}, name).request,
      h.timer.now(),
    );
    try {
      await waitForDiscoveries(h, 2);
      const fresh: { content: [] } = { content: [] };
      h.pending[1].resolve(fresh);
      expect(await later).toMatchObject({ success: true, result: fresh });
      expect(h.discoveries()).toBe(2);
    } finally {
      succeed(h);
      await Promise.all([first, later]);
    }
  });

  test.each([60_000, 120_000])("listDeviceImages retains a %ims caller budget", async (budget) => {
    const h = harness();
    const context = h.context({}, "listDeviceImages");
    context.totalTimeoutMs = budget;
    context.deadline = new ProgressExtendableDeadline(h.timer.now(), budget);
    const call = h.server.forwardRequest(context);
    await waitForDiscoveries(h, 1);
    expect(h.budgets).toEqual([budget]);
    h.timer.advanceTime(30_001);
    succeed(h);
    await call;
  });

  test("a longer-budget waiter starts separate work and survives the short waiter's timeout", async () => {
    const h = harness();
    const firstContext = h.context({}, "listDeviceImages");
    firstContext.totalTimeoutMs = 30_000;
    firstContext.deadline = new ProgressExtendableDeadline(h.timer.now(), 30_000);
    const first = Promise.allSettled([h.server.forwardRequest(firstContext)]);
    await waitForDiscoveries(h, 1);
    const longer = {
      ...firstContext,
      totalTimeoutMs: 120_000,
      deadline: new ProgressExtendableDeadline(h.timer.now(), 120_000),
    };
    const second = h.server.forwardRequest(longer);
    await waitForDiscoveries(h, 2);
    h.timer.advanceTime(30_001);
    expect((await first)[0].status).toBe("rejected");
    expect(h.signals.every((signal) => !signal?.aborted)).toBe(true);
    expect(h.budgets).toEqual([30_000, 120_000]);
    succeed(h);
    await second;
  });

  test("a later equal-budget waiter cannot join a flight that expires too early", async () => {
    const h = harness();
    const context = h.context();
    context.totalTimeoutMs = 60_000;
    context.deadline = new ProgressExtendableDeadline(h.timer.now(), 60_000);
    const first = Promise.allSettled([h.server.forwardRequest(context)]);
    await waitForDiscoveries(h, 1);
    h.timer.advanceTime(10_000);
    const second = h.server.forwardRequest({
      ...context,
      deadline: new ProgressExtendableDeadline(h.timer.now(), 60_000),
    });
    await waitForDiscoveries(h, 2);
    h.timer.advanceTime(50_001);
    expect((await first)[0].status).toBe("rejected");
    succeed(h);
    await second;
  });

  test.each([0, -1])(
    "an entry deadline with %ims remaining starts no inventory work",
    async (remaining) => {
      const h = harness();
      const context = h.context();
      context.deadline = new ProgressExtendableDeadline(h.timer.now(), remaining);
      const call = h.server.forwardRequest(context);
      h.timer.advanceTime(0);
      await expect(call).rejects.toBeInstanceOf(McpTimeoutError);
      expect(h.discoveries()).toBe(0);
      expect(h.scopes).toEqual([]);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
    },
  );
});
