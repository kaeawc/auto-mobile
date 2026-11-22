import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchyTelemetry } from "../../../../src/features/observe/ios/CtrlProxyHierarchyTelemetry";
import {
  IOS_WINDOW_LAYER_EXTRA,
  IOS_WINDOW_PACKAGE_EXTRA,
} from "../../../../src/features/observe/ios/iosWindowLayer";
import type { XCTestHierarchy } from "../../../../src/features/observe/ios/types";
import type { HierarchyNavigationDetector } from "../../../../src/features/navigation/HierarchyNavigationDetector";
import type { AccessibilityHierarchy } from "../../../../src/features/navigation/ScreenFingerprint";
import { FakeTimer } from "../../../fakes/FakeTimer";

/** Records what navigation detection receives, without a database or socket. */
function telemetryCapturing(): {
  telemetry: CtrlProxyHierarchyTelemetry;
  received: AccessibilityHierarchy[];
} {
  const received: AccessibilityHierarchy[] = [];
  const detector = {
    onHierarchyUpdate: (hierarchy: AccessibilityHierarchy) => {
      received.push(hierarchy);
    },
  } as Pick<HierarchyNavigationDetector, "onHierarchyUpdate"> as HierarchyNavigationDetector;
  const telemetry = new CtrlProxyHierarchyTelemetry({
    timer: new FakeTimer(),
    deviceId: "ipad",
    sdkCapability: {
      invalidateSdkCapabilities: () => {},
      refreshSdkCapabilitiesAndSync: async () => {},
    },
    buildContext: { ensureBuildContext: () => {} },
    // Already the foreground app, so no monitoring or SDK probing starts.
    lastForegroundBundleId: "com.apple.Preferences",
    getHierarchyNavigationDetector: () => detector,
  });
  return { telemetry, received };
}

/** Settings focused beside a merged Files window on an iPad (#18830). */
function ipadCapture(filesScreen: string): XCTestHierarchy {
  return {
    updatedAt: 1,
    packageName: "com.apple.Preferences",
    hierarchy: {
      className: "XCUIApplication",
      text: "Settings",
      node: [
        {
          className: "XCUIApplication",
          text: "Files",
          extras: {
            [IOS_WINDOW_LAYER_EXTRA]: "1",
            [IOS_WINDOW_PACKAGE_EXTRA]: "com.apple.DocumentsApp",
          },
          node: [{ className: "UIButton", text: filesScreen }],
        },
        { className: "UIButton", text: "General" },
      ],
    },
  };
}

describe("iOS navigation identity on an iPad with several app windows", () => {
  test("navigation in a background app does not change the focused app's screen", () => {
    const { telemetry, received } = telemetryCapturing();
    telemetry.handleHierarchyUpdateForNavigation(ipadCapture("Recents"));
    telemetry.handleHierarchyUpdateForNavigation(ipadCapture("Browse"));

    expect(received).toHaveLength(2);
    expect(JSON.stringify(received[0])).toBe(JSON.stringify(received[1]));
    expect(JSON.stringify(received[0])).not.toContain("Files");
    expect(JSON.stringify(received[0])).toContain("General");
  });
});
