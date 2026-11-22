import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSequencedWatchRunner } from "../../fakes/FakeWatchRunnerClient";
import { watchTapAt, watchTapOn } from "../../../src/features/watch/WatchActions";
import type { WatchHierarchy } from "../../../src/features/watch/WatchHierarchy";
import {
  WATCH_SHORT_LOOK_SETTLE_MS,
  hasWatchSystemAlert,
  isWatchNotificationShortLook,
  readSettledWatchHierarchy,
} from "../../../src/features/watch/WatchNotificationLook";
import { WatchRunnerError } from "../../../src/features/watch/WatchRunnerError";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import liveHierarchy from "../../fixtures/watchos-xcuitest/sdk-hierarchy-live.json";
import permissionAlert from "../../fixtures/watchos-xcuitest/notification-permission-alert.json";
import shortLook26 from "../../fixtures/watchos-xcuitest/notification-short-look.json";
import longLook26 from "../../fixtures/watchos-xcuitest/notification-long-look.json";
import shortLook27 from "../../fixtures/watchos-xcuitest/notification-short-look-watchos27.json";
import longLook27 from "../../fixtures/watchos-xcuitest/notification-long-look-watchos27.json";
import banner27 from "../../fixtures/watchos-xcuitest/notification-banner-watchos27.json";
import dismissed from "../../fixtures/watchos-xcuitest/notification-dismissed-app-not-foreground.json";

// Captured on a watchOS 27.2 simulator: the runner's reply after a tap closed the long look.
const dismissedError = new WatchRunnerError(dismissed.error, dismissed.errorCode);
const tree = (value: unknown) => value as WatchHierarchy;

const deviceId = "watch-notification-look";
let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

function autoTimer(): FakeTimer {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  return timer;
}

describe("isWatchNotificationShortLook", () => {
  test.each([
    ["watchOS 27.2 short look", shortLook27.data, true],
    ["watchOS 26.5 compact banner (title beside the icon)", shortLook26.data, false],
    ["watchOS 27.2 compact banner (title beside the icon)", banner27.data, false],
    ["watchOS 27.2 long look", longLook27.data, false],
    ["watchOS 26.5 long look", longLook26.data, false],
    ["permission prompt", permissionAlert.data, false],
    ["app without an alert", liveHierarchy, false],
  ])("%s -> %p", (_name, value, expected) => {
    expect(isWatchNotificationShortLook(tree(value))).toBe(expected);
  });

  test("an alert is a system alert, the app tree is not", () => {
    expect(hasWatchSystemAlert(tree(longLook27.data))).toBe(true);
    expect(hasWatchSystemAlert(tree(liveHierarchy))).toBe(false);
  });
});

describe("readSettledWatchHierarchy", () => {
  test("re-reads a short look until the long look with its actions replaces it", async () => {
    const reads = [shortLook27.data, shortLook27.data, longLook27.data].map(tree);
    let index = 0;
    const timer = autoTimer();
    const result = await readSettledWatchHierarchy(async () => reads[index++]!, timer);
    expect(result).toBe(reads[2]!);
    expect(timer.getSleepHistory()).toEqual([150, 150]);
  });

  test("returns the short look when it does not expand within the settle window", async () => {
    let count = 0;
    const timer = autoTimer();
    const result = await readSettledWatchHierarchy(async () => {
      count++;
      return tree(shortLook27.data);
    }, timer);
    expect(result).toBe(tree(shortLook27.data));
    expect(timer.getSleepHistory().reduce((sum, ms) => sum + ms, 0)).toBe(
      WATCH_SHORT_LOOK_SETTLE_MS,
    );
    expect(count).toBe(1 + timer.getSleepCallCount());
  });

  test("does not wait when no short look is up", async () => {
    const timer = autoTimer();
    await readSettledWatchHierarchy(async () => tree(longLook27.data), timer);
    await readSettledWatchHierarchy(async () => tree(permissionAlert.data), timer);
    await readSettledWatchHierarchy(async () => tree(banner27.data), timer);
    expect(timer.getSleepCallCount()).toBe(0);
  });
});

describe("watch taps on a notification look", () => {
  test("tapOn waits out the short look, taps the action and reports the dismissal", async () => {
    const client = new FakeSequencedWatchRunner(
      [shortLook27.data, longLook27.data],
      dismissedError,
    );
    unregister = watchRunners.register(deviceId, client);
    const timer = autoTimer();

    const result = await watchTapOn(deviceId, { action: "tap", text: "Accept" }, undefined, {
      timer,
    });

    expect(result.element).toMatchObject({ text: "Accept", class: "XCUIElementType(75)" });
    expect(result.effect).toEqual({ screenChanged: true, basis: "system alert dismissed" });
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "hierarchy" },
      { type: "hierarchy" },
      { type: "tap", x: 104, y: 138 },
      { type: "hierarchy" },
    ]);
  });

  test("tapOn taps the notification action, not the Smart Stack the look covers", async () => {
    // The face dump reads the clockface process, which still reports the stack under the look.
    const stackDump = readFileSync(
      new URL(
        "../../fixtures/watchos-clockface/fixture-face-smartstack-after-reload.txt",
        import.meta.url,
      ),
      "utf8",
    );
    class StackUnderLookRunner extends FakeSequencedWatchRunner {
      override async request(
        ...args: Parameters<FakeSequencedWatchRunner["request"]>
      ): Promise<unknown> {
        const result = await super.request(...args);
        return args[0].type === "face" && args[0].op === "dump" ? stackDump : result;
      }
    }
    const client = new StackUnderLookRunner([longLook27.data], dismissedError);
    unregister = watchRunners.register(deviceId, client);

    const result = await watchTapOn(deviceId, { action: "tap", text: "Accept" }, undefined, {
      timer: autoTimer(),
    });

    expect(result.element).toMatchObject({ text: "Accept", class: "XCUIElementType(75)" });
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "hierarchy" },
      { type: "hierarchy" },
      { type: "tap", x: 104, y: 138 },
      { type: "hierarchy" },
    ]);
  });

  test("tapAt over the long look reports the dismissal", async () => {
    const client = new FakeSequencedWatchRunner([longLook27.data], dismissedError);
    unregister = watchRunners.register(deviceId, client);

    const result = await watchTapAt(
      deviceId,
      { action: "tap", x: 104, y: 187 },
      undefined,
      autoTimer(),
    );

    expect(result.effect).toEqual({ screenChanged: true, basis: "system alert dismissed" });
  });

  test("app_not_foreground after a tap with no alert up stays insufficient data", async () => {
    const client = new FakeSequencedWatchRunner([liveHierarchy], dismissedError);
    unregister = watchRunners.register(deviceId, client);
    const result = await watchTapOn(
      deviceId,
      { action: "tap", text: "CtrlProxy Watch" },
      undefined,
      {
        timer: autoTimer(),
      },
    );

    expect(result.effect).toEqual({ screenChanged: false, basis: "insufficient observation data" });
  });
});
