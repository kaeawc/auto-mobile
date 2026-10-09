import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { FeatureFlagService } from "../../../../src/features/featureFlags/FeatureFlagService";
import { screenshotPathProtection } from "../../../../src/features/observe/ScreenshotPathProtection";
import type { ObserveResult } from "../../../../src/models";
import type { AdbClient } from "../../../../src/utils/android-cmdline-tools/AdbClient";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import { formatSwipeOnMessage } from "../../../../src/server/interactionTools";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeScrollableElementsQuery } from "../../../fakes/FakeElementTraitQueries";
import { FakeFeatureFlagApplier } from "../../../fakes/FakeFeatureFlagApplier";
import { FakeFeatureFlagRepository } from "../../../fakes/FakeFeatureFlagRepository";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeScreenshotCapturer } from "../../../fakes/FakeScreenshotCapturer";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import demosEnvelope from "../../../fixtures/ios/ios-demos-observe-full-sdk-nodes-not-injected.json";
import formsCapture from "../../../fixtures/observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json";
import launcherHome from "../../../fixtures/android-launcher/launcher-home-emulator-5602.json";
import playgroundMain from "../../../fixtures/android-enabled/playground-disabled-control-api36.json";

// Captured iPhone 17 Playground Demos list, and the Forms screen its "Forms & Input" row opens.
const demosList = JSON.parse(demosEnvelope.content[0].text) as ObserveResult;
const formsScreen = formsCapture as unknown as ObserveResult;

let restoreHostWorkGuards = () => {};
function installHostWorkGuards() {
  const guards = [
    spyOn(screenshotPathProtection, "start"),
    spyOn(defaultTimer, "sleep"),
    spyOn(defaultTimer, "setTimeout"),
    spyOn(defaultTimer, "setInterval"),
  ];
  for (const guard of guards) {
    guard.mockImplementation(() => {
      throw new Error("swipe navigation tests must not start real retention or timer waits");
    });
  }
  restoreHostWorkGuards = () => guards.forEach((guard) => guard.mockRestore());
}
beforeEach(installHostWorkGuards);
afterEach(() => restoreHostWorkGuards());

function harness(platform: "ios" | "android", before: ObserveResult, after: ObserveResult) {
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(before);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const action = new SwipeOn(
    { name: `${platform} fake`, deviceId: `${platform}-navigation`, platform },
    new FakeAdbClient() as unknown as AdbClient,
    {
      observeScreen,
      executeGesture: new FakeGestureExecutor(),
      screenshotCapturer: new FakeScreenshotCapturer(),
      featureFlags: new FeatureFlagService(
        new FakeFeatureFlagRepository(),
        new FakeFeatureFlagApplier(),
      ),
      scrollables: new FakeScrollableElementsQuery(),
      timer,
      voiceOverExecutor: new FakeTalkBackSwipeExecutor(),
      accessibilityDetector: new FakeAccessibilityDetector(),
    },
  );
  action.observedInteraction = async (run) => ({ ...(await run(before)), observation: after });
  return action;
}

describe("swipeOn navigation outcome", () => {
  // Pay the one-time module and projection warm-up outside the per-test budget.
  beforeAll(async () => {
    installHostWorkGuards();
    await harness("ios", demosList, demosList).execute({ direction: "up", autoTarget: false });
    restoreHostWorkGuards();
  });

  test("iOS screen swipe that opened another screen keeps success but reports navigation", async () => {
    const result = await harness("ios", demosList, formsScreen).execute({
      direction: "up",
      autoTarget: false,
    });
    expect(result.success).toBe(true);
    expect(result.navigated).toBe(true);
    expect(result.warning).toContain('Swipe navigated from "Demos" to "Forms"');
    expect(formatSwipeOnMessage(result, "up")).toBe(
      "Swiped up, but the screen changed instead of scrolling (see warning)",
    );
  });

  test("iOS swipe that stayed on the screen reports no navigation", async () => {
    const result = await harness("ios", demosList, demosList).execute({
      direction: "up",
      autoTarget: false,
    });
    expect(result.success).toBe(true);
    expect(result.navigated).toBe(false);
    expect(result.warning ?? "").not.toContain("Swipe navigated");
    expect(formatSwipeOnMessage(result, "up")).toBe("Swiped up");
  });

  test("Android screen swipe that changed the foreground activity reports navigation", async () => {
    const result = await harness(
      "android",
      launcherHome as unknown as ObserveResult,
      playgroundMain as unknown as ObserveResult,
    ).execute({ direction: "up", autoTarget: false });
    expect(result.success).toBe(true);
    expect(result.navigated).toBe(true);
    expect(result.effect).toEqual({ screenChanged: true, basis: "activeWindow changed" });
    expect(result.warning).toContain("NexusLauncherActivity");
    expect(result.warning ?? "").not.toContain("Swipe did not change the screen");
  });
});
