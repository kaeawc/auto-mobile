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
  test("emit reaches all subscribers with the released session id; unsubscribe stops delivery", () => {
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribeFirst = SessionReleaseBroadcaster.subscribe(sessionId => {
      first.push(sessionId);
    });
    const unsubscribeSecond = SessionReleaseBroadcaster.subscribe(sessionId => {
      second.push(sessionId);
    });

    try {
      SessionReleaseBroadcaster.emit("session-a");
      unsubscribeFirst();
      SessionReleaseBroadcaster.emit("session-a:device-a");

      expect(first).toEqual(["session-a"]);
      expect(second).toEqual(["session-a", "session-a:device-a"]);
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
