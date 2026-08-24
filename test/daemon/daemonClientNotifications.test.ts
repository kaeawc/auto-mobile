import { describe, expect, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client";
import { isDaemonNotification, type DaemonNotification } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

// Issue #3223: the daemon control socket carries server-pushed notification
// frames alongside request/response frames. These tests drive the private
// line-parsing path directly (no real socket) so they stay fast and hermetic.

function feed(client: DaemonClient, frames: unknown[]): void {
  const payload = frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n";
  (client as unknown as { handleData(data: Buffer): void }).handleData(Buffer.from(payload));
}

describe("isDaemonNotification", () => {
  test("accepts a well-formed notification frame", () => {
    expect(
      isDaemonNotification({
        type: "daemon_notification",
        method: "notifications/tools/list_changed",
      }),
    ).toBe(true);
  });

  test("rejects responses, null, and malformed frames", () => {
    expect(isDaemonNotification({ id: "1", type: "mcp_response", success: true })).toBe(false);
    expect(isDaemonNotification(null)).toBe(false);
    expect(isDaemonNotification("daemon_notification")).toBe(false);
    expect(isDaemonNotification({ type: "daemon_notification" })).toBe(false);
    expect(isDaemonNotification({ type: "daemon_notification", method: 42 })).toBe(false);
  });
});

describe("DaemonClient notification frames", () => {
  test("routes notification frames to registered handlers", () => {
    const client = new DaemonClient("/tmp/never-connected.sock", 1000, new FakeTimer());
    const received: DaemonNotification[] = [];
    client.onNotification((notification) => {
      received.push(notification);
    });

    feed(client, [{ type: "daemon_notification", method: "notifications/tools/list_changed" }]);

    expect(received).toEqual([
      { type: "daemon_notification", method: "notifications/tools/list_changed" },
    ]);
  });

  test("notification frames interleaved with responses do not disturb response handling", () => {
    const client = new DaemonClient("/tmp/never-connected.sock", 1000, new FakeTimer());
    const received: string[] = [];
    client.onNotification((notification) => {
      received.push(notification.method);
    });

    // A response for an unknown request id only logs; a notification dispatches.
    feed(client, [
      { id: "unknown-id", type: "mcp_response", success: true, result: {} },
      { type: "daemon_notification", method: "notifications/resources/list_changed" },
    ]);

    expect(received).toEqual(["notifications/resources/list_changed"]);
  });

  test("a throwing handler does not block sibling handlers", () => {
    const client = new DaemonClient("/tmp/never-connected.sock", 1000, new FakeTimer());
    const received: string[] = [];
    client.onNotification(() => {
      throw new Error("handler boom");
    });
    client.onNotification((notification) => {
      received.push(notification.method);
    });

    expect(() =>
      feed(client, [{ type: "daemon_notification", method: "notifications/tools/list_changed" }]),
    ).not.toThrow();
    expect(received).toEqual(["notifications/tools/list_changed"]);
  });

  test("onNotification returns an unsubscribe function", () => {
    const client = new DaemonClient("/tmp/never-connected.sock", 1000, new FakeTimer());
    const received: string[] = [];
    const unsubscribe = client.onNotification((notification) => {
      received.push(notification.method);
    });

    unsubscribe();
    feed(client, [{ type: "daemon_notification", method: "notifications/tools/list_changed" }]);

    expect(received).toEqual([]);
  });
});
