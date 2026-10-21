import { describe, expect, test } from "bun:test";
import { tapPlatformTraits } from "../../../../src/features/action/strategies/tapPlatformTraits";

// Each row pins the `device.platform` comparison TapOnElement made before #11837 moved it here.
describe("tapPlatformTraits", () => {
  test("android", () => {
    expect(tapPlatformTraits("android")).toEqual({
      tapDispatch: "android",
      androidLinkActivation: true,
      iosLinkActivation: false,
      capturedOwnerIdentity: false,
      routesAndroidDisplay: true,
      detectsAccessibilityBeforeSearch: true,
      refreshesAccessibilityHierarchyBeforeSearch: true,
      revalidatesCachedTargets: true,
      canReuseAccessibilityState: true,
      requiresFreshExtractionForCachedTarget: false,
      panelAwareSelection: false,
    });
  });

  test("ios", () => {
    expect(tapPlatformTraits("ios")).toEqual({
      tapDispatch: "ios",
      androidLinkActivation: false,
      iosLinkActivation: true,
      capturedOwnerIdentity: true,
      routesAndroidDisplay: false,
      detectsAccessibilityBeforeSearch: false,
      refreshesAccessibilityHierarchyBeforeSearch: false,
      revalidatesCachedTargets: true,
      canReuseAccessibilityState: false,
      requiresFreshExtractionForCachedTarget: true,
      panelAwareSelection: true,
    });
  });

  test("an unsupported platform has no dispatch ladder and no platform behavior", () => {
    for (const platform of ["web", "", "toString", "__proto__"]) {
      expect(tapPlatformTraits(platform)).toMatchObject({
        tapDispatch: undefined,
        androidLinkActivation: false,
        iosLinkActivation: false,
        revalidatesCachedTargets: false,
        canReuseAccessibilityState: true,
        requiresFreshExtractionForCachedTarget: false,
      });
    }
  });
});
