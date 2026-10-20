import { DAEMON_OWNED_SESSIONS_OWNER_TOKEN_PARAM } from "../../src/daemon/constants";
import { describe, expect, test } from "bun:test";
import { fakeBindLock, unreachableMcpDispatcher } from "../helpers/createTestUnixSocketServer";
import { UnixSocketServerHarness } from "./helpers/UnixSocketServerHarness";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { StubMcpClient } from "./helpers/fakeMcpClient";
import { currentForwardSessionKey } from "../../src/daemon/socketServer/forwardSessionKey";
import { FakeTimer } from "../fakes/FakeTimer";
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
  server.mcpClientFactory = async () => {
    scopes.push(currentForwardSessionKey());
    return new StubMcpClient({
      callTool: (_params, options) => {
        discoveries++;
        signals.push(options?.signal);
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
  return { server, timer, pending, signals, scopes, context, discoveries: () => discoveries };
}

async function flush() {
  for (let i = 0; i < 35; i++) {
    await Promise.resolve();
  }
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
      await flush();
      const count = h.discoveries();
      succeed(h);
      const results = await Promise.all(calls);
      expect(count).toBe(1);
      expect(results.every((result) => result === results[0])).toBe(true);
      const later = h.server.forwardRequest(h.context(reordered, name));
      await flush();
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
    await flush();
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
    await flush();
    const count = h.discoveries();
    succeed(h);
    await Promise.all(calls);
    expect(count).toBe(1);
  });

  test("shares errors without poisoning the next discovery", async () => {
    const h = harness();
    const calls = [h.server.forwardRequest(h.context()), h.server.forwardRequest(h.context())];
    const settled = Promise.allSettled(calls);
    await flush();
    const count = h.discoveries();
    const error = new Error("discovery failed");
    for (const gate of h.pending) {
      gate.reject(error);
    }
    const answers = await settled;
    expect(count).toBe(1);
    expect(answers).toEqual([
      { status: "rejected", reason: error },
      { status: "rejected", reason: error },
    ]);
    const later = h.server.forwardRequest(h.context());
    await flush();
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
    await flush();
    if (mode === "abort") {
      controller.abort(new Error("caller left"));
    } else {
      h.timer.advanceTime(1001);
    }
    await flush();
    const stillAlive = h.signals.every((signal) => !signal?.aborted);
    succeed(h);
    await second;
    expect((await firstResult)[0].status).toBe("rejected");
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
    await flush();
    const count = h.discoveries();
    succeed(h);
    await flush();
    succeed(h);
    await Promise.all(calls);
    expect(count).toBe(2);
  });
});
