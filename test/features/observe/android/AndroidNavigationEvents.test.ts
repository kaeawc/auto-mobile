import { describe, expect, test } from "bun:test";
import {
  AndroidInteractionTracker,
  AndroidNavigationWriteQueue,
  INTERACTION_NAVIGATION_WINDOW_MS,
} from "../../../../src/features/observe/android/AndroidNavigationEvents";
import type { NavigationEvent } from "../../../../src/features/navigation/NavigationGraphManager";
import { FakeTimer } from "../../../fakes/FakeTimer";

const navEvent = (overrides: Partial<NavigationEvent> = {}): NavigationEvent =>
  ({ applicationId: "com.app", timestamp: 100, ...overrides }) as NavigationEvent;

describe("AndroidInteractionTracker", () => {
  function tracker() {
    const timer = new FakeTimer();
    const instance = new AndroidInteractionTracker(timer);
    instance.lastInteractionByApp.set("com.app", {
      type: "tap",
      elementText: "Buy",
      elementResourceId: "id/buy",
      timestamp: 50,
      receivedAtMs: timer.now(),
    });
    return { timer, instance };
  }

  test("attaches the triggering interaction to a following navigation event", () => {
    const { instance } = tracker();
    const event = navEvent();
    instance.attachRecentInteraction(event);
    expect(event.triggeringInteraction).toEqual({
      type: "tap",
      elementText: "Buy",
      elementResourceId: "id/buy",
    });
  });

  test("an interaction that postdates the event, or has aged out, is not attached and is pruned", () => {
    const { timer, instance } = tracker();
    const earlier = navEvent({ timestamp: 10 });
    instance.attachRecentInteraction(earlier);
    expect(earlier.triggeringInteraction).toBeUndefined();
    timer.advanceTime(INTERACTION_NAVIGATION_WINDOW_MS + 1);
    const late = navEvent();
    instance.attachRecentInteraction(late);
    expect(late.triggeringInteraction).toBeUndefined();
    expect(instance.lastInteractionByApp.size).toBe(0);
  });

  test("a throwing listener does not stop the others and unsubscribe works", () => {
    const { instance } = tracker();
    const seen: string[] = [];
    instance.onInteraction(() => {
      throw new Error("boom");
    });
    const off = instance.onInteraction((event) => seen.push(event.type));
    instance.notifyInteractionListeners({ type: "tap" } as never);
    off();
    instance.notifyInteractionListeners({ type: "swipe" } as never);
    expect(seen).toEqual(["tap"]);
  });
});

describe("AndroidNavigationWriteQueue", () => {
  test("stamps the device id and keeps writing after a failed event", async () => {
    const recorded: Array<string | undefined> = [];
    let failFirst = true;
    const queue = new AndroidNavigationWriteQueue({
      deviceId: "emu",
      getNavigationGraphManager: () => ({
        recordNavigationEvent: async (event: NavigationEvent) => {
          recorded.push(event.deviceId);
          if (failFirst) {
            failFirst = false;
            throw new Error("db");
          }
        },
      }),
    });
    await expect(queue.enqueue(navEvent())).rejects.toThrow("db");
    await queue.enqueue(navEvent());
    expect(recorded).toEqual(["emu", "emu"]);
  });
});
