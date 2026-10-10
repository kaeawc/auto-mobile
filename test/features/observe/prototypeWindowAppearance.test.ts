import { describe, expect, test } from "bun:test";
import capture from "../../fixtures/android-launcher/launcher-recents-emulator-5602.json";
import { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../src/features/observe/android/types";
import type { PrototypeWindowAppearance } from "../../../src/models/ViewHierarchyResult";
import { FakeTimer } from "../../fakes/FakeTimer";
import { RELABELLED_CAPTURE } from "../../helpers/prototypeWindowCapture";

/**
 * No device capture carries `prototypeAppearance` yet (it needs an APK advertising
 * `prototype_appearance_v1`), so the field is added to one window entry of the captured API 36
 * two-window wire JSON, as prototypeWindowCapture.ts does for `prototypePlacement`.
 */
function convert(appearance?: PrototypeWindowAppearance) {
  const wire = JSON.parse(capture.rawViewHierarchy.json) as AccessibilityHierarchy;
  wire.windows = wire.windows?.map((window) =>
    window.id === RELABELLED_CAPTURE.prototypeWindowId && appearance
      ? { ...window, prototypePlacement: "sheet", prototypeAppearance: appearance }
      : window,
  );
  return new CtrlProxyHierarchy({
    timer: new FakeTimer(),
  } as HierarchyDelegateContext).convertToViewHierarchyResult(wire);
}

describe("prototypeAppearance on a hierarchy window entry (#11223)", () => {
  test("passes through the hierarchy conversion unchanged, on the prototype window only", () => {
    const appearance: PrototypeWindowAppearance = {
      mode: "dark",
      source: "authoredBackground",
      deviceDark: false,
    };
    const windows = convert(appearance).windows ?? [];
    const prototypeWindow = windows.find(
      (window) => window.id === RELABELLED_CAPTURE.prototypeWindowId,
    );
    expect(prototypeWindow?.prototypeAppearance).toEqual(appearance);
    expect(prototypeWindow?.prototypePlacement).toBe("sheet");
    const others = windows.filter((window) => window.id !== RELABELLED_CAPTURE.prototypeWindowId);
    expect(others.length).toBeGreaterThan(0);
    for (const window of others) {
      expect(window).not.toHaveProperty("prototypeAppearance");
    }
  });

  test("a capture from an APK without the capability has no such key on any window", () => {
    const windows = convert().windows ?? [];
    expect(windows.length).toBeGreaterThan(1);
    expect(JSON.stringify(windows)).not.toContain("prototypeAppearance");
  });
});
