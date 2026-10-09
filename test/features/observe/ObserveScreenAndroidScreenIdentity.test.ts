import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { deriveSdkNavigationScreenIdentity } from "../../../src/features/observe/sdkScreenIdentity";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import playgroundCapture from "../../fixtures/android-enabled/playground-disabled-control-api36.json";

const PLAYGROUND = "dev.jasonpearson.automobile.playground";
const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

/** The captured Playground design-system screen (MainActivity, no app pane title). */
function capturedHierarchy(): ViewHierarchyResult {
  const observation = structuredClone(playgroundCapture) as unknown as ObserveResult;
  return { ...observation.viewHierarchy!, packageName: PLAYGROUND };
}

async function observe(viewHierarchy: FakeViewHierarchy): Promise<ObserveResult> {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  adb.setForegroundApp({ packageName: PLAYGROUND, userId: 0 });
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(adb),
    { viewHierarchy, cacheStore: new FakeObserveCacheStore(timer) },
    timer,
  );
  return screen.execute({ skipScreenshot: true, skipBackStack: true });
}

describe("ObserveScreen Android screen identity", () => {
  // Pay the observe pipeline's one-time module/JIT warm-up outside the per-test budget.
  beforeAll(async () => {
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(capturedHierarchy());
    await observe(viewHierarchy);
    displayTransitions.reset(device.deviceId);
    resetObserveCacheStore();
  });

  afterEach(() => {
    displayTransitions.reset(device.deviceId);
    resetObserveCacheStore();
  });

  test("reports the app's SDK navigation route as the screen identity", async () => {
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(capturedHierarchy());
    viewHierarchy.configureScreenIdentity(
      deriveSdkNavigationScreenIdentity("android", PLAYGROUND, {
        destination: "DemoContrastDestination",
      }),
    );

    const result = await observe(viewHierarchy);

    expect(result.screenIdentity).toMatchObject({
      platform: "android",
      source: "sdk",
      confidence: "high",
      components: { bundleId: PLAYGROUND, navigationRoute: "DemoContrastDestination" },
    });
  });

  test("leaves the screen identity unset without an SDK route or app pane title", async () => {
    const viewHierarchy = new FakeViewHierarchy();
    viewHierarchy.configureHierarchy(capturedHierarchy());

    const result = await observe(viewHierarchy);

    expect(result.viewHierarchy?.packageName).toBe(PLAYGROUND);
    expect(result.screenIdentity).toBeUndefined();
  });
});
