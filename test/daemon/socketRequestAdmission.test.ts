import { describe, expect, test } from "bun:test";
import {
  latestBarrierCompletionOrder,
  nextSocketRequestOrder,
  resolveSocketAdmissionLane,
  SocketRequestAdmissionQueue,
} from "../../src/daemon/socketRequestAdmission";
import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
} from "../../src/daemon/wire/constants";
import { createFakeDaemonState } from "./helpers/inputSocketHarness";
import { createHarnessServer } from "./helpers/UnixSocketServerHarness";
import { FakeSocket } from "../fakes/FakeNetServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { daemonResponseFrameSchema } from "../helpers/wireMessageSchemas";

function toolsCall(name: string, args: Record<string, unknown>): DaemonRequest {
  return { id: "1", type: "mcp_request", method: "tools/call", params: { name, arguments: args } };
}

/** Enqueue a handler that records its start and finishes only when released. */
function enqueueBlocked(
  queue: SocketRequestAdmissionQueue,
  lane: string | undefined,
  label: string,
  started: string[],
): { done: Promise<string>; release: () => void } {
  const gate = Promise.withResolvers<void>();
  const done = queue.run(lane, async () => {
    started.push(label);
    await gate.promise;
    return label;
  });
  return { done, release: () => gate.resolve() };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("SocketRequestAdmissionQueue", () => {
  test("tracks barriers across queues by completion order", async () => {
    const queueA = new SocketRequestAdmissionQueue();
    const queueB = new SocketRequestAdmissionQueue();
    const before = latestBarrierCompletionOrder();
    const first = enqueueBlocked(queueA, undefined, "first", []);
    const second = enqueueBlocked(queueB, undefined, "second", []);
    expect(latestBarrierCompletionOrder()).toBe(before);

    const flightOrder = nextSocketRequestOrder();
    second.release();
    await second.done;
    await flush();
    const secondCompletion = latestBarrierCompletionOrder();
    expect(secondCompletion).toBeGreaterThan(flightOrder);

    first.release();
    await first.done;
    await flush();
    expect(latestBarrierCompletionOrder()).toBeGreaterThan(secondCompletion);
  });

  test("failed barriers advance the cutoff but laned requests do not", async () => {
    const queue = new SocketRequestAdmissionQueue();
    const before = latestBarrierCompletionOrder();
    await expect(
      queue.run(undefined, async () => {
        throw new Error("barrier failed after possible mutation");
      }),
    ).rejects.toThrow("barrier failed after possible mutation");
    await flush();
    const completion = latestBarrierCompletionOrder();
    expect(completion).toBeGreaterThan(before);

    await queue.run("host:inventory", async () => {});
    await flush();
    expect(latestBarrierCompletionOrder()).toBe(completion);
  });

  test("starts requests in different lanes concurrently", async () => {
    const queue = new SocketRequestAdmissionQueue();
    const started: string[] = [];
    const a = enqueueBlocked(queue, "device:a", "a", started);
    const b = enqueueBlocked(queue, "device:b", "b", started);

    expect(started).toEqual(["a", "b"]);
    expect(queue.pendingCount).toBe(0);
    b.release();
    a.release();
    expect(await Promise.all([a.done, b.done])).toEqual(["a", "b"]);
  });

  test("keeps arrival order within one lane", async () => {
    const queue = new SocketRequestAdmissionQueue();
    const started: string[] = [];
    const first = enqueueBlocked(queue, "device:a", "first", started);
    const second = enqueueBlocked(queue, "device:a", "second", started);
    const other = enqueueBlocked(queue, "device:b", "other", started);

    expect(started).toEqual(["first", "other"]);
    expect(queue.pendingCount).toBe(1);
    first.release();
    await first.done;
    await flush();
    expect(started).toEqual(["first", "other", "second"]);
    second.release();
    other.release();
    await Promise.all([second.done, other.done]);
  });

  test("a barrier waits for earlier requests and holds back later ones", async () => {
    const queue = new SocketRequestAdmissionQueue();
    const started: string[] = [];
    const laned = enqueueBlocked(queue, "device:a", "laned", started);
    const barrier = enqueueBlocked(queue, undefined, "barrier", started);
    const later = enqueueBlocked(queue, "device:b", "later", started);

    expect(started).toEqual(["laned"]);
    laned.release();
    await laned.done;
    await flush();
    expect(started).toEqual(["laned", "barrier"]);
    barrier.release();
    await barrier.done;
    await flush();
    expect(started).toEqual(["laned", "barrier", "later"]);
    later.release();
    await later.done;
  });

  test("propagates a handler failure and keeps admitting", async () => {
    const queue = new SocketRequestAdmissionQueue();
    const failed = queue.run(undefined, async () => {
      throw new Error("boom");
    });
    const next = queue.run(undefined, async () => "next");

    await expect(failed).rejects.toThrow("boom");
    expect(await next).toBe("next");
  });

  test("expires a queued same-lane request without running it", async () => {
    const timer = new FakeTimer();
    const queue = new SocketRequestAdmissionQueue();
    const started: string[] = [];
    const first = enqueueBlocked(queue, "device:a", "first", started);
    const expired = queue.run("device:a", async () => started.push("expired"), {
      timer,
      deadlineMs: 500,
      signal: new AbortController().signal,
      timeoutError: (sameLaneWait) => new Error(`timed out in queue: ${sameLaneWait}`),
    });
    expect(queue.pendingCount).toBe(1);
    timer.advanceTime(500);
    await expect(expired).rejects.toThrow("timed out in queue: true");
    expect(queue.pendingCount).toBe(0);
    first.release();
    await first.done;
    expect(started).toEqual(["first"]);
  });

  test("cancels a pending request and frees its slot", async () => {
    const queue = new SocketRequestAdmissionQueue();
    const timer = new FakeTimer();
    const first = enqueueBlocked(queue, "device:a", "first", []);
    const cancellation = new AbortController();
    const queued = queue.run("device:a", async () => "ran", {
      timer,
      deadlineMs: 500,
      signal: cancellation.signal,
      timeoutError: () => new Error("timed out"),
    });
    cancellation.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrow("cancelled");
    expect(queue.pendingCount).toBe(0);
    first.release();
    await first.done;
  });
});

describe("resolveSocketAdmissionLane", () => {
  test("lanes a tools/call by its explicit deviceId", () => {
    expect(resolveSocketAdmissionLane(toolsCall("tapOn", { deviceId: "emulator-5554" }))).toBe(
      "device:emulator-5554",
    );
    expect(
      resolveSocketAdmissionLane(
        toolsCall("observe", { deviceId: "d1", [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: "p" }),
      ),
    ).toBe("device:d1");
  });

  test("lanes device-free inventory tools separately from device calls", () => {
    expect(resolveSocketAdmissionLane(toolsCall("listDevices", {}))).toBe("host:inventory");
    expect(resolveSocketAdmissionLane(toolsCall("listDeviceImages", {}))).toBe("host:inventory");
    expect(
      resolveSocketAdmissionLane(toolsCall("listDevices", { sessionUuid: "s1" })),
    ).toBeUndefined();
  });

  test("treats session-routed, acquisition, and non-tool requests as barriers", () => {
    const barriers: DaemonRequest[] = [
      toolsCall("tapOn", {}),
      toolsCall("tapOn", { deviceId: "" }),
      toolsCall("tapOn", { deviceId: "d1", sessionUuid: "s1" }),
      toolsCall("tapOn", { deviceId: "d1", device: "A" }),
      toolsCall("tapOn", { deviceId: "d1", [DAEMON_BOUND_SESSION_PARAM]: "s1" }),
      toolsCall("tapOn", { deviceId: "d1", [DAEMON_OWNED_SESSIONS_PARAM]: ["s1"] }),
      toolsCall("startDevice", { deviceId: "d1" }),
      toolsCall("setActiveDevice", { deviceId: "d1" }),
      toolsCall("setToolEnabled", { deviceId: "d1" }),
      { id: "1", type: "mcp_request", method: "input/tap", params: { deviceId: "d1" } },
    ];
    for (const request of barriers) {
      expect(resolveSocketAdmissionLane(request)).toBeUndefined();
    }
  });
});

test.each([undefined, "device:a"])(
  "daemon shapes expired admission in lane %s as never started",
  async (lane) => {
    const timer = new FakeTimer();
    const socket = new FakeSocket();
    const server = createHarnessServer("unused", createFakeDaemonState(), timer);
    server.allowRequests();
    const first = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    let secondStarted = false;
    server.localRequestHandler = async (request) => {
      if (request.id === "first") {
        started.resolve();
        return first.promise;
      }
      secondStarted = true;
      return {};
    };
    server.connect(socket);
    const request = (id: string): DaemonRequest => ({
      id,
      type: "mcp_request",
      method: "tools/call",
      params: { name: "tapOn", arguments: lane ? { deviceId: "a" } : {} },
      timeoutMs: 500,
    });
    socket.simulateData(JSON.stringify(request("first")) + "\n");
    await started.promise;
    socket.simulateData(JSON.stringify(request("second")) + "\n");
    timer.advanceTime(500);
    await flush();
    first.resolve({});
    await flush();
    expect(secondStarted).toBe(false);
    expect(
      socket
        .getWrittenMessages(daemonResponseFrameSchema)
        .find((response) => response.id === "second"),
    ).toMatchObject({
      success: false,
      code: "daemon_queue_timeout",
      error: expect.stringContaining("timed out in queue"),
    });
  },
);

test("overlapping host inventory reads respect earlier and later barriers", async () => {
  const queue = new SocketRequestAdmissionQueue();
  const started: string[] = [];
  const earlier = enqueueBlocked(queue, undefined, "earlier", started);
  const first = enqueueBlocked(queue, "host:inventory", "first", started);
  const second = enqueueBlocked(queue, "host:inventory", "second", started);
  const later = enqueueBlocked(queue, undefined, "later", started);
  expect(started).toEqual(["earlier"]);
  earlier.release();
  await earlier.done;
  await flush();
  expect(started).toEqual(["earlier", "first", "second"]);
  first.release();
  await first.done;
  await flush();
  expect(started).not.toContain("later");
  second.release();
  await second.done;
  await flush();
  expect(started).toEqual(["earlier", "first", "second", "later"]);
  later.release();
  await later.done;
});
