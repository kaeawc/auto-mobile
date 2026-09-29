import { describe, expect, test } from "bun:test";
import {
  resolveSocketAdmissionLane,
  SocketRequestAdmissionQueue,
} from "../../src/daemon/socketRequestAdmission";
import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
} from "../../src/daemon/constants";
import type { DaemonRequest } from "../../src/daemon/types";

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
