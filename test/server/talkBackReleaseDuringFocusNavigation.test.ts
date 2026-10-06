import { describe, expect, test } from "bun:test";
import { cancelAndReleaseSession } from "../../src/daemon/releaseSessionAndDevice";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  restoreScreenReaderState,
  type ScreenReaderToggles,
} from "../../src/features/accessibility/ScreenReaderRestore";
import {
  FocusNavigationExecutor,
  FocusNavigationStoppedError,
} from "../../src/features/talkback/FocusNavigationExecutor";
import type { Element } from "../../src/models/Element";
import { runSessionScreenReaderMutation } from "../../src/server/sessionScreenReader";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeFocusNavigationDriver } from "../fakes/FakeFocusNavigationDriver";
import { FakeTimer } from "../fakes/FakeTimer";

const android = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };

const makeElement = (resourceId: string, index: number): Element => ({
  bounds: { left: index * 10, top: index * 10, right: index * 10 + 5, bottom: index * 10 + 5 },
  "resource-id": resourceId,
});

/**
 * One device whose TalkBack state and event order are shared by the `accessibility` tool, the
 * session restore and a focus navigation. The navigation's focus request only moves the cursor
 * while TalkBack is on, so one recorded after the restore turned it off would be the defect.
 */
function harness() {
  const timer = new FakeTimer();
  const events: string[] = [];
  let talkBackEnabled = false;
  const restoreWrites: boolean[] = [];

  const toggles: ScreenReaderToggles = {
    talkBack: () => ({
      toggle: async (enabled) => {
        events.push(`restore-${enabled ? "on" : "off"}`);
        restoreWrites.push(enabled);
        talkBackEnabled = enabled;
        return { supported: true, applied: true, currentState: enabled };
      },
    }),
    voiceOver: () => ({
      toggle: async () => ({ supported: true, applied: false, currentState: false }),
    }),
  };
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    () => ({ restore: async () => {} }),
    () => ({ restore: async () => {} }),
    {
      networkCondition: () => ({ restore: async () => {} }),
      clock: () => ({ restore: async () => {} }),
      screenReader: (target) => ({
        restore: (state, signal) => restoreScreenReaderState(target, state, signal, toggles),
      }),
    },
  );

  const driver = new FakeFocusNavigationDriver();
  driver.exposeHierarchy = true;
  driver.setElements(
    Array.from({ length: 12 }, (_, index) => makeElement(`e${index}`, index)),
    0,
  );
  driver.onFocusAction = () => {
    events.push(talkBackEnabled ? "focus" : "focus-with-talkback-off");
  };
  const executor = new FocusNavigationExecutor({
    timer,
    driverFactory: { createDriver: () => driver },
  });

  /** The `accessibility` tool turning TalkBack on, recording the state it found. */
  const enableTalkBackInSession = (sessionUuid: string) =>
    runSessionScreenReaderMutation(manager, sessionUuid, android.deviceId, async (slot) => {
      slot?.record({ platform: "android", previousEnabled: talkBackEnabled });
      talkBackEnabled = true;
      events.push("tool-enabled");
    });

  return {
    timer,
    events,
    manager,
    driver,
    executor,
    enableTalkBackInSession,
    restoreWrites,
    isEnabled: () => talkBackEnabled,
  };
}

describe("session release while TalkBack focus navigation is in flight (#10144, #10146)", () => {
  test("the navigation stops before the restore turns TalkBack off, and the restore runs once", async () => {
    const h = harness();
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.enableTalkBackInSession("s1");

      // The request is cancelled by the daemon's session release, exactly as
      // `cancelAndReleaseSession` does it: abort the session's executions, then release.
      const request = new AbortController();
      const navigation = h.executor
        .navigateToElement("device-1", { resourceId: "e10" }, { signal: request.signal })
        .then(
          () => "reached" as const,
          (error: unknown) => error,
        );
      // The focus request is sent and navigation is parked in its settle delay (FakeTimer does not advance).
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve();
      }
      expect(h.driver.getFocusRequestCount()).toBe(1);

      await cancelAndReleaseSession(
        "s1",
        "explicit-release",
        () => h.manager.releaseSession("s1", "explicit-release"),
        {
          hasActiveSessionUuidExecutions: () => true,
          cancelSessionUuidExecutions: async () => {
            h.events.push("cancel");
            request.abort();
            return 1;
          },
        },
      );
      const outcome = await navigation;

      expect(outcome).toBeInstanceOf(FocusNavigationStoppedError);
      expect((outcome as Error).message).toContain(
        "1 accessibility-focus request already moved the TalkBack cursor",
      );
      // Nothing is dispatched between the cancel and the restore, and nothing after it. When the
      // navigation's own rejection surfaces relative to the restore is deliberately not pinned.
      expect(h.events).toEqual(["tool-enabled", "focus", "cancel", "restore-off"]);
      expect(h.restoreWrites).toEqual([false]);
      expect(h.isEnabled()).toBe(false);

      // The parked settle delay firing later, or a second release, sends nothing more.
      h.timer.advanceTime(1000);
      await h.manager.releaseSession("s1", "explicit-release");
      for (let turn = 0; turn < 20; turn++) {
        await Promise.resolve();
      }
      expect(h.driver.getFocusRequestCount()).toBe(1);
      expect(h.restoreWrites).toEqual([false]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a navigation that finished before the release leaves exactly one restore and no stop error", async () => {
    const h = harness();
    h.timer.enableAutoAdvance();
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.enableTalkBackInSession("s1");

      const reached = await h.executor.navigateToElement(
        "device-1",
        { resourceId: "e10" },
        { signal: new AbortController().signal },
      );
      await h.manager.releaseSession("s1", "explicit-release");

      expect(reached).toBe(true);
      expect(h.events.filter((event) => event === "focus")).toHaveLength(1);
      expect(h.events.at(-1)).toBe("restore-off");
      expect(h.events).not.toContain("focus-with-talkback-off");
      expect(h.restoreWrites).toEqual([false]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });

  test("a navigation cancelled with no focus request sent reports no cursor movement and the restore still runs", async () => {
    const h = harness();
    try {
      await h.manager.createSession("s1", android.deviceId, "android");
      await h.enableTalkBackInSession("s1");
      const request = new AbortController();
      request.abort();

      const failure = await h.executor
        .navigateToElement("device-1", { resourceId: "e10" }, { signal: request.signal })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await h.manager.releaseSession("s1", "explicit-release");

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain("partially applied");
      expect(h.driver.getFocusRequestCount()).toBe(0);
      expect(h.restoreWrites).toEqual([false]);
    } finally {
      h.manager.stopCleanupTimer();
    }
  });
});
