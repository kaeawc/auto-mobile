import { describe, expect, test } from "bun:test";
import { describeForegroundOverlay } from "../../../src/features/navigation/foregroundOverlay";

const APP = "com.example.app";
const appWindow = { appId: APP, activityName: ".Main", layoutSeqSum: 0 };

describe("describeForegroundOverlay (#10133)", () => {
  test("the app's own window is not an overlay", () => {
    expect(describeForegroundOverlay({ activeWindow: appWindow }, APP)).toBeUndefined();
    expect(describeForegroundOverlay({}, APP)).toBeUndefined();
    expect(describeForegroundOverlay({ activeWindow: appWindow }, null)).toBeUndefined();
  });

  test("names a notification permission dialog and an intent chooser", () => {
    expect(describeForegroundOverlay({ notificationPermissionDetected: true }, APP)).toBe(
      "a notification permission dialog",
    );
    expect(describeForegroundOverlay({ intentChooserDetected: true }, APP)).toBe(
      "an intent chooser",
    );
  });

  test("names a modal presentation from the screen identity", () => {
    const screenIdentity = {
      platform: "ios",
      source: "sdk",
      confidence: "high",
      key: "k",
      components: { modalTitle: "Share" },
    } as const;
    expect(describeForegroundOverlay({ screenIdentity }, APP)).toBe("a modal presentation (Share)");
  });

  test("names a system surface, a classified window and another app's window", () => {
    expect(
      describeForegroundOverlay(
        { activeWindow: { ...appWindow, appId: "com.android.systemui", systemOverlay: true } },
        APP,
      ),
    ).toBe("a system surface (com.android.systemui)");
    expect(
      describeForegroundOverlay({ activeWindow: { ...appWindow, type: "system_dialog" } }, APP),
    ).toBe("a system dialog");
    expect(
      describeForegroundOverlay({ activeWindow: { ...appWindow, appId: "com.other" } }, APP),
    ).toBe("another app window (com.other)");
  });
});
