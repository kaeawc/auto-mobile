import { beforeAll, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DaemonHandoffInterruptionError,
  DAEMON_HANDOFF_INTERRUPTED_MESSAGE,
} from "../../src/daemon/daemonHandoffInterruption";
import { type AsyncScope, InProcessMcpDispatcher } from "../../src/daemon/inProcessMcpDispatcher";
import {
  currentForwardSessionKey,
  runWithForwardSessionKey,
} from "../../src/daemon/socketServer/forwardSessionKey";
import type { StatelessMcpRequestScope } from "../../src/daemon/statelessMcpHttpEndpoint";
import type { McpRequestSessionContext } from "../../src/daemon/statelessMcpServerFactory";
import type { ExecutionCancellationReason } from "../../src/daemon/executionTracker";
import { createSdkMcpServer } from "../../src/server/sdkMcpServer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

const ambient = new AsyncLocalStorage<string>();

interface Built {
  readonly context: McpRequestSessionContext;
  readonly scope: StatelessMcpRequestScope;
  /** The `block` call's handler signal, once it started. */
  blockSignal?: AbortSignal;
  /** What the handler saw of the ambient store. */
  ambientInHandler?: string;
  closed: boolean;
}

function harness(
  options: { serverScope?: AsyncScope; refreshResources?: () => Promise<void> } = {},
) {
  const built: Built[] = [];
  const cancelled: Array<{ scope: string; reason: ExecutionCancellationReason }> = [];
  const forgotten: string[] = [];
  let reason: ExecutionCancellationReason = "streamable_http_onclose";
  let markBlockStarted!: () => void;
  const blockStarted = new Promise<void>((resolve) => {
    markBlockStarted = resolve;
  });
  const dispatcher = new InProcessMcpDispatcher({
    idGenerator: new CountingIdGenerator("scope"),
    createServer: (context, scope) => {
      const record: Built = { context, scope, closed: false };
      built.push(record);
      const server = createSdkMcpServer({ name: "test", version: "1.0.0" }, { tools: {} });
      server.server.setRequestHandler("tools/call", async (request, ctx) => {
        record.ambientInHandler = ambient.getStore();
        if (request.params.name === "block") {
          record.blockSignal = ctx.mcpReq.signal;
          markBlockStarted();
          await new Promise<void>((resolve) =>
            ctx.mcpReq.signal.addEventListener("abort", () => resolve()),
          );
        }
        return {
          content: [{ type: "text", text: "ok" }],
          structuredContent: { dropped: undefined, kept: 1 },
        };
      });
      const close = server.close.bind(server);
      server.close = async () => {
        record.closed = true;
        await close();
      };
      return server;
    },
    cancelScopeExecutions: async (scope, why) => {
      cancelled.push({ scope, reason: why });
      return 0;
    },
    forgetScopeBindings: (scope) => forgotten.push(scope),
    closeReason: () => reason,
    ...options,
  });
  return {
    dispatcher,
    built,
    cancelled,
    forgotten,
    blockStarted,
    setCloseReason: (next: ExecutionCancellationReason) => {
      reason = next;
    },
  };
}

describe("InProcessMcpDispatcher (#11820)", () => {
  // The SDK client and server build their handlers and validators on first use. That one-time
  // cost belongs to the process, not to whichever test runs first (or alone, in the budget's
  // isolated re-run), so drive one connect, call and close before the timed tests.
  beforeAll(async () => {
    const client = await harness().dispatcher.connect({ sessionKey: "warm-up" });
    await client.callTool({ name: "echo", arguments: {} });
    await client.close();
  });

  test("cached resource freshness runs in the server root without opening a loopback client", async () => {
    let observed: string | undefined;
    const h = ambient.run("daemon-root", () =>
      harness({
        refreshResources: async () => {
          observed = ambient.getStore();
        },
      }),
    );
    await ambient.run("socket-caller", () => h.dispatcher.refreshResources!());
    expect(observed).toBe("daemon-root");
    expect(h.built).toHaveLength(0);
    expect(h.dispatcher.inFlightCount).toBe(0);
  });

  test("each forward gets its own server with the forward's context and session key", async () => {
    const h = harness();
    const first = await h.dispatcher.connect({ boundSessionUuid: "bound", sessionKey: "socket-1" });
    const second = await h.dispatcher.connect({ releasedSessionUuid: "released" });

    expect(h.built.map((record) => record.scope)).toEqual([
      { requestScopeId: "scope-1", requestMcpSessionId: "socket-1", trustedForwarder: true },
      { requestScopeId: "scope-2", requestMcpSessionId: undefined, trustedForwarder: true },
    ]);
    expect(h.built[0].context).toEqual({ initialSessionToolBinding: "bound" });
    expect(h.built[1].context).toEqual({ initialReleasedSession: "released" });
    expect(h.dispatcher.inFlightCount).toBe(2);
    await first.close();
    await second.close();
    expect(h.dispatcher.inFlightCount).toBe(0);
  });

  test("a result crosses a JSON boundary, like the HTTP hop", async () => {
    const h = harness();
    const client = await h.dispatcher.connect({ sessionKey: "socket-1" });
    const result = await client.callTool({ name: "echo", arguments: {} });
    expect(result.structuredContent).toEqual({ kept: 1 });
    expect("dropped" in (result.structuredContent as object)).toBe(false);
    await client.close();
  });

  test("the handler runs in the dispatcher's root context, not the forward's", async () => {
    const h = ambient.run("dispatcher-start", () => harness());
    const client = await ambient.run("socket-side", () =>
      h.dispatcher.connect({ sessionKey: "socket-1" }),
    );
    await ambient.run("socket-side", () => client.callTool({ name: "echo", arguments: {} }));
    expect(h.built[0].ambientInHandler).toBe("dispatcher-start");
    await client.close();
  });

  test("a pass-through server scope lets the forward's context leak (what the root prevents)", async () => {
    const h = harness({ serverScope: { run: (fn) => fn() } });
    const client = await h.dispatcher.connect({ sessionKey: "socket-1" });
    await ambient.run("socket-side", () => client.callTool({ name: "echo", arguments: {} }));
    expect(h.built[0].ambientInHandler).toBe("socket-side");
    await client.close();
  });

  test("an aborted call cancels the running handler before the forward closes", async () => {
    const h = harness();
    const client = await h.dispatcher.connect({ sessionKey: "socket-1" });
    const controller = new AbortController();
    const reason = new Error("client cancelled");
    const call = client
      .callTool({ name: "block", arguments: {} }, { signal: controller.signal })
      .catch((error: unknown) => error);
    await h.blockStarted;

    controller.abort(reason);

    // The caller sees the abort's own reason (the v1 contract), and the paired server got
    // notifications/cancelled while the forward is still open.
    expect(await call).toBe(reason);
    for (let turn = 0; turn < 10 && !h.built[0].blockSignal?.aborted; turn++) {
      await Promise.resolve();
    }
    expect(h.built[0].blockSignal?.aborted).toBe(true);
    expect(h.built[0].closed).toBe(false);
    await client.close();
  });

  test("closing a forward cancels its scope with the close reason, then closes its server", async () => {
    const h = harness();
    const client = await h.dispatcher.connect({ sessionKey: "socket-1" });
    await client.close();
    await client.close();
    expect(h.cancelled).toEqual([{ scope: "scope-1", reason: "streamable_http_onclose" }]);
    expect(h.built[0].closed).toBe(true);
    // A keyed forward's bindings belong to its session key, not its scope.
    expect(h.forgotten).toEqual([]);
  });

  test("a keyless forward forgets the bindings recorded under its one-off scope", async () => {
    const h = harness();
    const client = await h.dispatcher.connect({});
    await client.close();
    expect(h.forgotten).toEqual(["scope-1"]);
  });

  test("shutdown refuses new forwards and closes running ones with the handoff reason", async () => {
    const h = harness();
    const running = await h.dispatcher.connect({ sessionKey: "socket-1" });
    const call = running
      .callTool({ name: "block", arguments: {} })
      .catch((error: unknown) => error);
    await h.blockStarted;

    h.dispatcher.stopAccepting();
    const handoff = new DaemonHandoffInterruptionError(DAEMON_HANDOFF_INTERRUPTED_MESSAGE);
    h.setCloseReason(handoff);
    await Promise.all(h.dispatcher.inFlightForwards().map((forward) => forward.close()));

    expect(h.cancelled).toEqual([{ scope: "scope-1", reason: handoff }]);
    expect(h.built[0].blockSignal?.aborted).toBe(true);
    expect(await call).toBeInstanceOf(Error);
    expect(h.dispatcher.inFlightCount).toBe(0);
    await expect(h.dispatcher.connect({ sessionKey: "socket-2" })).rejects.toBeInstanceOf(
      DaemonHandoffInterruptionError,
    );
    expect(h.built).toHaveLength(1);
  });

  test("a forward's session key travels with its async chain to the client factory", async () => {
    expect(currentForwardSessionKey()).toBeUndefined();
    const seen = await runWithForwardSessionKey("socket-7", async () => {
      await Promise.resolve();
      return currentForwardSessionKey();
    });
    expect(seen).toBe("socket-7");
    expect(currentForwardSessionKey()).toBeUndefined();
  });
});
