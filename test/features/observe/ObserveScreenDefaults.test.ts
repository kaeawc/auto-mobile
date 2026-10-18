import { describe, expect, test } from "bun:test";
import {
  resolveObserveDataSources,
  resolveObserveViewHierarchy,
  resolveObserveScreenDependencies,
  unavailableReadOnlyHierarchy,
  type ObserveScreenDefaultsContext,
} from "../../../src/features/observe/ObserveScreenDefaults";
import { createObserveScreenWiring } from "../../../src/features/observe/ObserveScreenWiring";
import type { ObserveScreenDependencies } from "../../../src/features/observe/ObserveScreenDependencies";
import type { BootedDevice } from "../../../src/models";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeWindow } from "../../fakes/FakeWindow";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { noopObserveAudits } from "../../fakes/noopObserveAudits";

const device: BootedDevice = { name: "test", platform: "android", deviceId: "emulator-5554" };

function context(dependencies?: ObserveScreenDependencies): ObserveScreenDefaultsContext {
  const adbFactory = new FakeAdbClientFactory(new FakeAdbExecutor());
  const wiring = createObserveScreenWiring({
    device,
    adb: () => adbFactory.create(device),
    adbFactory: () => adbFactory,
    observeScreenProvider: () => new FakeObserveScreen(),
    identity: {
      device: () => device,
      viewHierarchy: () => new FakeViewHierarchy(),
      deviceStateCollector: () => {
        throw new Error("collector is created lazily");
      },
      timer: () => new FakeTimer(),
      platformValidator: () => {
        throw new Error("validator is created lazily");
      },
      resolveObservationTimestampMs: () => undefined,
      extractScreenSizeFromHierarchy: () => null,
    },
  });
  return {
    device,
    adbFactory,
    timer: new FakeTimer(),
    idGenerator: new CountingIdGenerator(),
    wiring,
    dependencies,
  };
}

describe("resolveObserveScreenDependencies", () => {
  test("returns injected data sources untouched", () => {
    const viewHierarchy = new FakeViewHierarchy();
    const window = new FakeWindow();
    const ctx = context({ viewHierarchy, window });
    const sources = resolveObserveDataSources(ctx);
    expect(resolveObserveViewHierarchy(ctx)).toBe(viewHierarchy);
    expect(sources.window).toBe(window);
  });

  test("a read-only device without an injected hierarchy gets the unavailable hierarchy", () => {
    const hierarchy = resolveObserveViewHierarchy(context({ deviceReadOnly: true }));
    expect(hierarchy).toBe(unavailableReadOnlyHierarchy);
  });

  test("an injected hierarchy wins over the read-only default", () => {
    const viewHierarchy = new FakeViewHierarchy();
    const hierarchy = resolveObserveViewHierarchy(context({ deviceReadOnly: true, viewHierarchy }));
    expect(hierarchy).toBe(viewHierarchy);
  });

  test("injected audits and evidence flow through to the services", () => {
    const { performanceAuditor, accessibilityAuditor, accessibilityStateDetector } =
      noopObserveAudits();
    const { services } = resolveObserveScreenDependencies(
      context({ performanceAuditor, accessibilityAuditor, accessibilityStateDetector }),
    );
    expect(services.performanceAuditor).toBe(performanceAuditor);
    expect(services.accessibilityAuditor).toBe(accessibilityAuditor);
    expect(services.accessibilityStateDetector).toBe(accessibilityStateDetector);
  });
});
