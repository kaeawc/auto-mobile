/**
 * Deterministic fixtures for the `observe`, `pressButton`, `tapOn`, `launchApp` and `installApp`
 * benchmarks (#11375).
 *
 * The real handlers reach adb, `xcrun simctl` and the CtrlProxy transport, so a benchmark over them
 * measures the host's tooling (and whether it is installed), not the handler. Each fixture injects
 * the repo's test fakes through the handler's existing seam, so no process is spawned and no
 * database, daemon or device is touched:
 * - observe: `registerObserveTools({ createScreen })` over a `FakeObserveScreen` serving the
 *   captured Android home observation (`test/fixtures/observe/android-home.json`).
 * - tapOn: a real `TapOnElement` over fakes (hierarchy capture, observe screen, accessibility tap,
 *   in-memory navigation DB) resolving a node of the same captured hierarchy.
 * - pressButton / launchApp / installApp: the handler's action factory returns a canned success.
 *   Those handlers are thin wrappers, so the gate covers their request/response plumbing.
 */
import { RealWaitForCondition } from "../src/features/observe/WaitForCondition";
import { TapOnElement } from "../src/features/action/TapOnElement";
import { SearchableHierarchy } from "../src/features/utility/SearchableNode";
import type { BootedDevice, ObserveResult } from "../src/models";
import type { InstallAppResult } from "../src/models/InstallAppResult";
import type { LaunchAppResult } from "../src/models/LaunchAppResult";
import type { PressButtonResult } from "../src/models/PressButtonResult";
import {
  resetInstallAppToolDependencies,
  resetInstalledAppResourceRefresh,
  resetLaunchAppToolDependencies,
  setInstallAppToolDependencies,
  setInstalledAppResourceRefresh,
  setLaunchAppToolDependencies,
} from "../src/server/appTools";
import {
  resetPressButtonFactory,
  resetTapOnElementFactory,
  setPressButtonFactory,
  setTapOnElementFactory,
} from "../src/server/interactionTools";
import { registerObserveTools } from "../src/server/observeTools";
import { ResourceRegistry } from "../src/server/resourceRegistry";
import { FakeAccessibilityDetector } from "../test/fakes/FakeAccessibilityDetector";
import { FakeAdbExecutor } from "../test/fakes/FakeAdbExecutor";
import { FakeHierarchyCapture } from "../test/fakes/FakeHierarchyCapture";
import { FakeObserveScreen } from "../test/fakes/FakeObserveScreen";
import { FakeScreenshotCapturer } from "../test/fakes/FakeScreenshotCapturer";
import { FakeScreenshotPathProtection } from "../test/fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../test/fakes/FakeTimer";
import { loadAndroidHomeObserve } from "../test/fixtures/observe/observeFixture";
import { installBenchmarkNavigationManager } from "./benchmark-navigation-fixture";

export interface ToolFixture {
  /** Restore the process-wide state the fixture replaced. */
  dispose(): void | Promise<void>;
  /** Arguments to call the handler with, when the generic mock arguments do not fit it. */
  args?: Record<string, unknown>;
}

export type DeviceToolFixtureName =
  | "observe"
  | "pressButton"
  | "tapOn"
  | "launchApp"
  | "installApp";

const APP_ID = "com.mock.app";
const ARTIFACT_PATH = "/benchmark/mock-app.apk";

/** A captured observation, cloned so a fixture never mutates the shared parse. */
function capturedObservation(): ObserveResult {
  return structuredClone(loadAndroidHomeObserve().observe);
}

function installObserveFixture(): ToolFixture {
  const screen = new FakeObserveScreen();
  const result = capturedObservation();
  // The captured back stack feeds the navigation graph (a database); the benchmark has none.
  delete result.backStack;
  screen.setObserveResult(result);
  const timer = new FakeTimer();
  const notify = ResourceRegistry.notifyResourcesUpdated;
  ResourceRegistry.notifyResourcesUpdated = async () => {};
  registerObserveTools({
    timer,
    pathProtection: new FakeScreenshotPathProtection(timer),
    createScreen: () => ({
      execute: screen.execute.bind(screen),
      executeDeviceRead: screen.execute.bind(screen),
      captureScreenshot: screen.captureScreenshot.bind(screen),
      appendRawViewHierarchy: screen.appendRawViewHierarchy.bind(screen),
      getMostRecentCachedObserveResult: screen.getMostRecentCachedObserveResult.bind(screen),
    }),
  });
  return {
    args: { platform: "android" },
    dispose() {
      ResourceRegistry.notifyResourcesUpdated = notify;
      // Put back the production registration the fixture replaced.
      registerObserveTools();
    },
  };
}

async function installTapOnFixture(): Promise<ToolFixture> {
  const navigation = await installBenchmarkNavigationManager();
  const initial = capturedObservation();
  const hierarchy = initial.viewHierarchy!;
  const target = new SearchableHierarchy()
    .project(hierarchy)
    .find((node) => node.affordances.includes("tap") && node.element?.text);
  if (!target?.element?.text) {
    throw new Error("Captured Android home has no labelled tap target");
  }
  const baseUpdatedAt = hierarchy.updatedAt ?? 0;
  const capturedAt = (index: number) => ({ ...hierarchy, updatedAt: baseUpdatedAt + index });
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observe = new FakeObserveScreen();
  // The post-tap settle only accepts a capture newer than the one it started from.
  observe.setObserveResult((index) =>
    index === 0
      ? initial
      : { ...initial, observationId: "after-tap", viewHierarchy: capturedAt(index) },
  );
  setTapOnElementFactory((device: BootedDevice) => {
    const tap = new TapOnElement(device, new FakeAdbExecutor(), {
      lastRenderedObservation: () => initial,
      timer,
      waitForCondition: new RealWaitForCondition(observe, timer),
      hierarchyCapture: new FakeHierarchyCapture(() => capturedAt(1)),
      accessibilityDetector: new FakeAccessibilityDetector(),
      screenshotCapturer: new FakeScreenshotCapturer(),
    });
    tap.observeScreen = observe;
    tap.window.getCachedActiveWindow = async () => null;
    tap["accessibilityService"].requestTapCoordinates = async () => ({ success: true });
    return tap;
  });
  return {
    args: {
      platform: "android",
      selector: { text: target.element.text },
      action: "tap",
      selectionStrategy: "first",
      retryIfNoChange: false,
    },
    async dispose() {
      resetTapOnElementFactory();
      await navigation.dispose();
    },
  };
}

function installPressButtonFixture(): ToolFixture {
  const result: PressButtonResult = {
    success: true,
    button: "home",
    keyCode: 3,
    observation: capturedObservation(),
  };
  setPressButtonFactory(() => ({ execute: async () => result }));
  return { args: { platform: "android", button: "home" }, dispose: resetPressButtonFactory };
}

/** The installed-app resource refresh invalidates a cache and notifies subscribers of the resource. */
function fakeInstalledAppResourceRefresh(): void {
  setInstalledAppResourceRefresh({ invalidate() {}, notify: async () => {} });
}

function installLaunchAppFixture(): ToolFixture {
  const result: LaunchAppResult = {
    success: true,
    packageName: APP_ID,
    observation: capturedObservation(),
  };
  fakeInstalledAppResourceRefresh();
  setLaunchAppToolDependencies({ createLaunchApp: () => ({ execute: async () => result }) });
  return {
    args: { platform: "android", appId: APP_ID },
    dispose() {
      resetLaunchAppToolDependencies();
      resetInstalledAppResourceRefresh();
    },
  };
}

function installInstallAppFixture(): ToolFixture {
  const result: InstallAppResult = {
    success: true,
    artifactPath: ARTIFACT_PATH,
    packageName: APP_ID,
  };
  fakeInstalledAppResourceRefresh();
  setInstallAppToolDependencies({ createInstallApp: () => ({ execute: async () => result }) });
  return {
    args: { platform: "android", artifactPath: ARTIFACT_PATH },
    dispose() {
      resetInstallAppToolDependencies();
      resetInstalledAppResourceRefresh();
    },
  };
}

export async function installDeviceToolFixture(name: DeviceToolFixtureName): Promise<ToolFixture> {
  switch (name) {
    case "observe":
      return installObserveFixture();
    case "tapOn":
      return installTapOnFixture();
    case "pressButton":
      return installPressButtonFixture();
    case "launchApp":
      return installLaunchAppFixture();
    case "installApp":
      return installInstallAppFixture();
  }
}
