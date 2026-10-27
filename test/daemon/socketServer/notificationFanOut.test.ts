import { describe, expect, test } from "bun:test";
import {
  applyResourceSubscription,
  broadcastListChanged,
  broadcastResourceUpdated,
  broadcastSessionReleased,
  broadcastSessionDeviceRebound,
  pushProgressNotification,
  type NotificationTransport,
} from "../../../src/daemon/socketServer/notificationFanOut";
import type { DaemonNotification, DaemonRequest } from "../../../src/daemon/types";

class FakeTransport implements NotificationTransport {
  readonly writes: Array<{ sessionId: string; frame: DaemonNotification }> = [];
  readonly flushes: Array<() => void> = [];
  constructor(private readonly live: ReadonlySet<string>) {}
  hasSocket(sessionId: string): boolean {
    return this.live.has(sessionId);
  }
  write(sessionId: string, frame: DaemonNotification, onFlushed?: () => void): void {
    this.writes.push({ sessionId, frame });
    if (onFlushed) {
      this.flushes.push(onFlushed);
    }
  }
}

function subscribeRequest(method: string, uri?: unknown): DaemonRequest {
  return { id: "r1", type: "mcp_request", method, params: { uri } } as DaemonRequest;
}

describe("notificationFanOut", () => {
  test("list-changed skips subscribers without a live socket", () => {
    const transport = new FakeTransport(new Set(["a"]));
    broadcastListChanged(["a", "gone"], transport, "tools");
    expect(transport.writes.map((w) => w.sessionId)).toEqual(["a"]);
    expect(transport.writes[0].frame.type).toBe("daemon_notification");
  });

  test("resource-updated resolves targets only for live sockets", () => {
    const transport = new FakeTransport(new Set(["a"]));
    const resolved: string[][] = [];
    broadcastResourceUpdated(
      new Map([
        ["a", new Set(["u1"])],
        ["gone", new Set(["u2"])],
      ]),
      transport,
      (subs) => {
        resolved.push([...subs]);
        return [...subs, "extra"];
      },
    );
    expect(resolved).toEqual([["u1"]]);
    expect(transport.writes.map((w) => w.frame.uri)).toEqual(["u1", "extra"]);
  });

  test("subscribe adds, unsubscribe drops the empty set, and a missing uri fails", () => {
    const subs = new Map<string, Set<string>>();
    expect(
      applyResourceSubscription(subs, "s", subscribeRequest("resources/subscribe", "u")),
    ).toMatchObject({ success: true });
    expect(subs.get("s")).toEqual(new Set(["u"]));
    applyResourceSubscription(subs, "s", subscribeRequest("resources/unsubscribe", "u"));
    expect(subs.has("s")).toBe(false);
    expect(
      applyResourceSubscription(subs, "s", subscribeRequest("resources/subscribe", "")),
    ).toMatchObject({ success: false, error: "Resource subscription requires params.uri" });
  });

  test("session-released tracks pending writes until flushed", () => {
    const transport = new FakeTransport(new Set(["a"]));
    const pending = new Set<Promise<void>>();
    broadcastSessionReleased(["a", "gone"], transport, pending, {
      releasedSessionId: "sess",
      reason: "idle",
      recordingIds: ["rec"],
    });
    expect(transport.writes).toHaveLength(1);
    expect(transport.writes[0].frame).toMatchObject({
      sessionId: "sess",
      reason: "idle",
      recordingIds: ["rec"],
    });
    expect(pending.size).toBe(1);
    transport.flushes[0]();
    expect(pending.size).toBe(0);
  });

  test("rebound reaches only live subscribed sockets and drains its writes", () => {
    const transport = new FakeTransport(new Set(["subscribed", "not-subscribed"]));
    const pending = new Set<Promise<void>>();
    const event = {
      sessionId: "s",
      previousDeviceId: "a",
      deviceId: "b",
      stableDeviceId: "Pixel",
      avdName: "Pixel",
      generation: 1,
    };
    broadcastSessionDeviceRebound(["subscribed", "gone"], transport, pending, event);
    expect(transport.writes).toEqual([
      {
        sessionId: "subscribed",
        frame: {
          type: "daemon_notification",
          method: "notifications/automobile/sessionDeviceRebound",
          ...event,
        },
      },
    ]);
    expect(pending.size).toBe(1);
    transport.flushes[0]();
    expect(pending.size).toBe(0);
  });

  test("progress targets one live socket and omits unset fields", () => {
    const transport = new FakeTransport(new Set(["a"]));
    pushProgressNotification(transport, "gone", { requestId: "r", progressToken: 1, progress: 1 });
    pushProgressNotification(transport, "a", { requestId: "r", progressToken: "tok", progress: 2 });
    expect(transport.writes).toHaveLength(1);
    const frame = transport.writes[0].frame;
    expect(frame).toMatchObject({ requestId: "r", progressToken: "tok", progress: 2 });
    expect("total" in frame).toBe(false);
    expect("message" in frame).toBe(false);
  });
});
