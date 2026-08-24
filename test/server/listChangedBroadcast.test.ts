import { describe, expect, test } from "bun:test";
import {
  ListChangedBroadcaster,
  LIST_CHANGED_NOTIFICATION_METHODS,
  listChangedKindForMethod,
} from "../../src/server/listChangedBroadcast";

describe("listChangedKindForMethod", () => {
  test("round-trips both kinds through the shared method map", () => {
    expect(listChangedKindForMethod(LIST_CHANGED_NOTIFICATION_METHODS.tools)).toBe("tools");
    expect(listChangedKindForMethod(LIST_CHANGED_NOTIFICATION_METHODS.resources)).toBe("resources");
  });

  test("returns undefined for unknown methods", () => {
    expect(listChangedKindForMethod("notifications/prompts/list_changed")).toBeUndefined();
    expect(listChangedKindForMethod("")).toBeUndefined();
  });
});

describe("ListChangedBroadcaster", () => {
  test("emit reaches all subscribers; unsubscribe stops delivery", () => {
    const first: string[] = [];
    const second: string[] = [];
    const unsubscribeFirst = ListChangedBroadcaster.subscribe((kind) => {
      first.push(kind);
    });
    const unsubscribeSecond = ListChangedBroadcaster.subscribe((kind) => {
      second.push(kind);
    });

    try {
      ListChangedBroadcaster.emit("tools");
      unsubscribeFirst();
      ListChangedBroadcaster.emit("resources");

      expect(first).toEqual(["tools"]);
      expect(second).toEqual(["tools", "resources"]);
    } finally {
      unsubscribeFirst();
      unsubscribeSecond();
    }
  });

  test("a throwing listener does not block sibling listeners", () => {
    const received: string[] = [];
    const unsubscribeThrowing = ListChangedBroadcaster.subscribe(() => {
      throw new Error("listener boom");
    });
    const unsubscribeHealthy = ListChangedBroadcaster.subscribe((kind) => {
      received.push(kind);
    });

    try {
      expect(() => ListChangedBroadcaster.emit("tools")).not.toThrow();
      expect(received).toEqual(["tools"]);
    } finally {
      unsubscribeThrowing();
      unsubscribeHealthy();
    }
  });
});
