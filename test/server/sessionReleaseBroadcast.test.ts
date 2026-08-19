import { describe, expect, test } from "bun:test";
import {
  SessionReleaseBroadcaster,
  SESSION_RELEASED_NOTIFICATION_METHOD,
} from "../../src/server/sessionReleaseBroadcast";

describe("SESSION_RELEASED_NOTIFICATION_METHOD", () => {
  test("is the stable session-released wire method", () => {
    expect(SESSION_RELEASED_NOTIFICATION_METHOD).toBe("notifications/session/released");
  });
});

describe("SessionReleaseBroadcaster", () => {
  test("emit reaches subscribers with the session id and reason; unsubscribe stops delivery", () => {
    const first: Array<{ sessionId: string; reason?: string }> = [];
    const second: Array<{ sessionId: string; reason?: string }> = [];
    const unsubscribeFirst = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      first.push({ sessionId, reason });
    });
    const unsubscribeSecond = SessionReleaseBroadcaster.subscribe((sessionId, reason) => {
      second.push({ sessionId, reason });
    });

    try {
      SessionReleaseBroadcaster.emit("session-a", "heartbeat-timeout");
      unsubscribeFirst();
      SessionReleaseBroadcaster.emit("session-a:device-a", "explicit-release");

      expect(first).toEqual([{ sessionId: "session-a", reason: "heartbeat-timeout" }]);
      expect(second).toEqual([
        { sessionId: "session-a", reason: "heartbeat-timeout" },
        { sessionId: "session-a:device-a", reason: "explicit-release" },
      ]);
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });

  test("a throwing listener does not block sibling listeners", () => {
    const received: string[] = [];
    const unsubscribeThrowing = SessionReleaseBroadcaster.subscribe(() => {
      throw new Error("listener boom");
    });
    const unsubscribeHealthy = SessionReleaseBroadcaster.subscribe(sessionId => {
      received.push(sessionId);
    });

    try {
      expect(() => SessionReleaseBroadcaster.emit("session-a")).not.toThrow();
      expect(received).toEqual(["session-a"]);
    } finally {
      unsubscribeThrowing();
      unsubscribeHealthy();
    }
  });
});
