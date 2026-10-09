import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../../src/ctrlProxy/constants";
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import { resetDbWriteBarrier } from "../../../../src/db/dbWriteBarrier";
import { NavigationGraphManager } from "../../../../src/features/navigation/NavigationGraphManager";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { AccessibilityHierarchy } from "../../../../src/features/observe/android/types";
import type { BootedDevice } from "../../../../src/models";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../../helpers/navigationTestHarness";
import {
  OVERLAY_CAPTURE,
  PROTOTYPE_CAPTURE,
  floatingCoverWireCapture,
  launcherWireWithOverlay,
  launcherWireWithPagedOverlay,
  wireWindowRoot,
  withoutWireWindow,
} from "../../../helpers/overlayWindowCapture";

/** Past the detector's 100 ms debounce, well inside its 5 s stability timeout. */
const SETTLE_MS = 150;

// Issue #9305 (e): hierarchy pushes feed navigation detection with the app's windows only, so a
// prototype overlay shown, paged, focused or dismissed over a screen records no navigation.
describe("AndroidCtrlProxyClient navigation ignores AutoMobile's overlay (#9305)", () => {
  const device: BootedDevice = {
    deviceId: "overlay-navigation-test-device",
    platform: "android",
    isEmulator: true,
    name: "Overlay navigation test device",
  };
  let navHarness: InMemoryNavManagerHarness;
  let timer: FakeTimer;
  let client: AndroidCtrlProxyClient;
  let recordHierarchyNavigation: ReturnType<typeof spyOn>;
  let updatedAt = 1;

  beforeAll(async () => {
    navHarness = await installInMemoryNavManager();
  });

  beforeEach(() => {
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.resetInstances();
    timer = new FakeTimer();
    client = AndroidCtrlProxyClient.createForTesting(
      device,
      new FakeAdbExecutor(),
      (url) => new FakeWebSocket(url, "none", 0, timer),
      timer,
    );
    recordHierarchyNavigation = spyOn(
      navHarness.manager,
      "recordHierarchyNavigation",
    ).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    recordHierarchyNavigation.mockRestore();
    client.cancelScreenshotBackoff();
    await client.close();
  });

  afterAll(async () => {
    await navHarness.dispose();
    NavigationGraphManager.resetInstance();
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    resetDbWriteBarrier();
  });

  const push = (capture: AccessibilityHierarchy): void => {
    client.handleHierarchyUpdate({ ...capture, updatedAt: updatedAt++ });
    client.cancelScreenshotBackoff();
    timer.advanceTime(SETTLE_MS);
  };

  const screenWithoutOverlay = (): AccessibilityHierarchy =>
    withoutWireWindow(launcherWireWithOverlay(), OVERLAY_CAPTURE.overlayWindowId);

  test("showing, paging and dismissing an overlay keeps the current screen", () => {
    push(screenWithoutOverlay());
    expect(recordHierarchyNavigation).toHaveBeenCalledTimes(1);
    const current = client.getHierarchyNavigationDetector().getCurrentFingerprint();
    expect(current?.packageName).toBe(OVERLAY_CAPTURE.appPackage);

    push(launcherWireWithOverlay());
    push(launcherWireWithPagedOverlay());
    push(screenWithoutOverlay());

    expect(recordHierarchyNavigation).toHaveBeenCalledTimes(1);
    expect(client.getHierarchyNavigationDetector().getCurrentFingerprint()?.hash).toBe(
      current!.hash,
    );
  });

  test("an overlay holding focus does not switch the screen to the overlay host's package", () => {
    const playground = floatingCoverWireCapture();
    push(withoutWireWindow(playground, PROTOTYPE_CAPTURE.floatingOverlayWindowId));
    expect(recordHierarchyNavigation).toHaveBeenCalledTimes(1);

    push({
      ...playground,
      // The device labels the capture with the overlay host while the overlay holds focus.
      packageName: CTRL_PROXY_PACKAGE,
      windows: playground.windows?.map((window) => ({
        ...window,
        isFocused: window.id === PROTOTYPE_CAPTURE.floatingOverlayWindowId,
        isActive: window.id === PROTOTYPE_CAPTURE.floatingOverlayWindowId,
      })),
    });

    expect(recordHierarchyNavigation).toHaveBeenCalledTimes(1);
    expect(client.getHierarchyNavigationDetector().getCurrentFingerprint()?.packageName).toBe(
      PROTOTYPE_CAPTURE.appPackage,
    );
  });

  test("an app change behind the overlay is still a navigation", () => {
    push(launcherWireWithOverlay());
    // The app window now shows another captured screen (the Playground's) under the same overlay.
    const appChanged = launcherWireWithOverlay();
    wireWindowRoot(appChanged, OVERLAY_CAPTURE.appWindowId).node = wireWindowRoot(
      floatingCoverWireCapture(),
      PROTOTYPE_CAPTURE.appWindowId,
    ).node;
    push(appChanged);

    expect(recordHierarchyNavigation).toHaveBeenCalledTimes(2);
  });
});
