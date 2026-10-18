import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { resetObserveCacheStore } from "../../src/features/observe/cache/ObserveCacheRegistry";
import type { ObserveResult } from "../../src/models";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeViewHierarchy } from "../fakes/FakeViewHierarchy";
import { runObserveScreenContract } from "./ObserveScreenContract";

runObserveScreenContract("FakeObserveScreen", () => {
  const screen = new FakeObserveScreen();
  return {
    screen,
    present: (marker) => {
      screen.setObserveResult((): ObserveResult => ({
        updatedAt: marker,
        screenSize: { width: 1080, height: 1920 },
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        viewHierarchy: { hierarchy: {} },
      }));
    },
  };
});

runObserveScreenContract("RealObserveScreen (fake hierarchy, cache store, timer)", () => {
  const timer = new FakeTimer();
  const hierarchy = new FakeViewHierarchy();
  const screen = new RealObserveScreen(
    { deviceId: "contract-device", name: "Contract", platform: "android" },
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      viewHierarchy: hierarchy,
      cacheStore: new FakeObserveCacheStore(timer),
      performanceAuditor: { run: async () => undefined } as never,
      accessibilityAuditor: { run: async () => undefined } as never,
      accessibilityStateDetector: { run: async () => undefined } as never,
    },
    timer,
  );
  return {
    screen,
    present: (marker) => {
      hierarchy.configureHierarchy({
        updatedAt: marker,
        screenWidth: 1080,
        screenHeight: 1920,
        systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        wakefulness: "Awake",
        hierarchy: {
          node: {
            bounds: { left: 0, top: 0, right: 1080, bottom: 1920 },
            node: [{ text: "Ready", bounds: { left: 0, top: 100, right: 200, bottom: 160 } }],
          },
        },
      } as never);
    },
    dispose: resetObserveCacheStore,
  };
});
