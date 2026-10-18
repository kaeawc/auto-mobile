import { describe, expect, test } from "bun:test";
import type { Socket } from "node:net";
import {
  PendingRequestTracker,
  type PendingSocketRequest,
} from "../../../src/daemon/socketServer/PendingRequestTracker";
import type { ProgressExtendableDeadline } from "../../../src/daemon/mcpRequestTimeout";

const socketA = {} as Socket;
const socketB = {} as Socket;

function request(id: string, socket: Socket, deadlineMs?: number): PendingSocketRequest {
  return {
    id,
    sessionId: `session-${id}`,
    socket,
    admitted: false,
    terminal: false,
    idleDeadline:
      deadlineMs === undefined ? undefined : ({ value: deadlineMs } as ProgressExtendableDeadline),
  };
}

describe("PendingRequestTracker", () => {
  test("tracks membership and size", () => {
    const tracker = new PendingRequestTracker();
    const r1 = request("1", socketA);
    tracker.add(r1);
    tracker.add(request("2", socketB));
    expect(tracker.size).toBe(2);
    tracker.delete(r1);
    expect(tracker.size).toBe(1);
    expect([...tracker].map((r) => r.id)).toEqual(["2"]);
  });

  test("deleteForSocket drops only that socket's requests", () => {
    const tracker = new PendingRequestTracker();
    tracker.add(request("1", socketA));
    tracker.add(request("2", socketA));
    tracker.add(request("3", socketB));
    tracker.deleteForSocket(socketA);
    expect([...tracker].map((r) => r.id)).toEqual(["3"]);
  });

  test("hasLiveRequest requires a matching socket and an unexpired deadline", () => {
    const tracker = new PendingRequestTracker();
    tracker.add(request("control", socketA));
    tracker.add(request("expired", socketA, 99));
    tracker.add(request("other", socketB, 500));
    expect(tracker.hasLiveRequest(socketA, 100)).toBe(false);
    tracker.add(request("live", socketA, 100));
    expect(tracker.hasLiveRequest(socketA, 100)).toBe(true);
    expect(tracker.hasLiveRequest(socketA, 101)).toBe(false);
  });
});
