import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INTERNAL_LIVE_DEADLINE_KEY_PARAM } from "../../src/daemon/constants";
import { getLiveTextRequestState } from "../../src/daemon/liveDeadlineRegistry";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

/**
 * #12393: a client cancel of a `tools/call` that already dispatched to the device must keep the
 * per-device forward key held until the tool settles (bounded by the request deadline), exactly as
 * `input/*` frames do through dispatchedRequestHold (#11967). The loopback SDK call rejects at once
 * on abort, so without a hold the next queued call interleaves with the still-writing tool.
 */
function createServer(timer: FakeTimer): UnixSocketServer {
  return new UnixSocketServer(
    join(tmpdir(), `cancel-dispatch-hold-${randomUUID()}.sock`),
    "http://localhost:0/mcp",
    {
      isInitialized: () => true,
      getSessionManager: () => ({
        getSession: () => null,
        getDeviceLabels: () => undefined,
        releaseSession: async () => null,
      }),
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
        releaseDevice: async () => {},
        resolveAutolockSessionForMcpSession: () => undefined,
      }),
    },
    timer,
  );
}

interface Internals {
  runKeyedMcpForward: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  handleIdeRequest: (
    client: unknown,
    request: DaemonRequest,
    timeoutMs: number,
    socketSessionId: string,
    deadline: ProgressExtendableDeadline,
    originalTimeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

const TIMEOUT_MS = 10_000;
const KEY = "device:A";

function setup(dispatchBeforeCancel: boolean) {
  const timer = new FakeTimer();
  const server = createServer(timer);
  const internals = server as unknown as Internals;
  const controller = new AbortController();
  let completeDispatch: ((confirmed: boolean) => void) | undefined;
  let replyTool: ((value: unknown) => void) | undefined;
  let liveKey: string | undefined;
  let toolStarted = false;
  // Mirrors the SDK client: abort rejects the call at once, the tool keeps running in-process.
  const client = {
    callTool: (
      params: { arguments: Record<string, unknown> },
      _schema: unknown,
      options: { signal?: AbortSignal },
    ) => {
      toolStarted = true;
      liveKey = String(params.arguments[INTERNAL_LIVE_DEADLINE_KEY_PARAM]);
      const state = getLiveTextRequestState(liveKey);
      if (dispatchBeforeCancel) {
        completeDispatch = state?.dispatched();
      }
      return new Promise((resolve, reject) => {
        replyTool = resolve;
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    },
  };
  const request: DaemonRequest = {
    id: "call-1",
    type: "mcp_request",
    method: "tools/call",
    params: { name: "inputText", arguments: { text: "hi", deviceId: "A" } },
  };
  const first = internals
    .runKeyedMcpForward(KEY, () =>
      internals.handleIdeRequest(
        client,
        request,
        TIMEOUT_MS,
        "socket-1",
        new ProgressExtendableDeadline(timer.now(), TIMEOUT_MS),
        TIMEOUT_MS,
        controller.signal,
      ),
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  let secondStarted = false;
  const second = internals.runKeyedMcpForward(KEY, async () => {
    secondStarted = true;
  });
  return {
    timer,
    controller,
    first,
    second,
    isToolStarted: () => toolStarted,
    isSecondStarted: () => secondStarted,
    finishTool: () => completeDispatch?.(true),
    replyTool: (value: unknown) => replyTool?.(value),
    isStateRegistered: () =>
      liveKey !== undefined && getLiveTextRequestState(liveKey) !== undefined,
  };
}

describe("tools/call client cancel after device dispatch (#12393)", () => {
  test("holds the per-device forward key until the dispatched tool settles", async () => {
    const t = setup(true);
    await drainMicrotasks(50);
    expect(t.isToolStarted()).toBe(true);

    t.controller.abort(new DOMException("cancelled", "AbortError"));
    await drainMicrotasks(100);
    expect(t.isSecondStarted()).toBe(false);
    expect(t.isStateRegistered()).toBe(true);

    t.finishTool();
    await t.second;
    expect(t.isSecondStarted()).toBe(true);
    const outcome = await t.first;
    expect(JSON.stringify(outcome)).toContain("indeterminate");
    expect(t.isStateRegistered()).toBe(false);
  });

  test("the hold is bounded by the request deadline", async () => {
    const t = setup(true);
    await drainMicrotasks(50);
    t.timer.advanceTime(6000);
    t.controller.abort(new DOMException("cancelled", "AbortError"));
    await drainMicrotasks(100);
    expect(t.isSecondStarted()).toBe(false);

    t.timer.advanceTime(3999);
    await drainMicrotasks(100);
    expect(t.isSecondStarted()).toBe(false);
    t.timer.advanceTime(1);
    await t.second;
    expect(t.isSecondStarted()).toBe(true);
    expect(await t.first).toHaveProperty("value");
    t.finishTool();
  });

  test("a cancel before any dispatch frees the key at once", async () => {
    const t = setup(false);
    await drainMicrotasks(50);
    t.controller.abort(new DOMException("cancelled", "AbortError"));
    await t.second;
    expect(t.isSecondStarted()).toBe(true);
    expect(await t.first).toHaveProperty("error");
  });

  test("a normal tools/call returns its result and frees the key", async () => {
    const t = setup(true);
    await drainMicrotasks(50);
    expect(t.isSecondStarted()).toBe(false);
    const result = { content: [{ type: "text", text: "typed" }] };
    t.finishTool();
    t.replyTool(result);
    expect(await t.first).toEqual({ value: result });
    await t.second;
    expect(t.isSecondStarted()).toBe(true);
    expect(t.isStateRegistered()).toBe(false);
    expect(t.timer.getPendingTimeoutCount()).toBe(0);
  });
});
