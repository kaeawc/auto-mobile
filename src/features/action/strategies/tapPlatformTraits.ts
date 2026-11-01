import { type AndroidOrIosPlatform, isAndroidOrIosPlatform } from "../../../models/Platform";

/**
 * The platform facts `TapOnElement` and its collaborators branch on, kept in one table so the
 * tap flow reads a named trait instead of comparing `device.platform` (#11837). Looked up from
 * the device, not the injected {@link TapStrategy}, so a test's fake strategy cannot change them.
 */
export interface TapPlatformTraits {
  /** Which `TapExecution` dispatch ladder runs the tap; undefined for an unsupported platform. */
  readonly tapDispatch: AndroidOrIosPlatform | undefined;
  /** Accessibility links are activated through the Android node action. */
  readonly androidLinkActivation: boolean;
  /** Accessibility links are activated through the iOS runner. */
  readonly iosLinkActivation: boolean;
  /** A link owner is unique by its captured resource-id, not by a stable node selector. */
  readonly capturedOwnerIdentity: boolean;
  /** Taps route to a target Android display. */
  readonly routesAndroidDisplay: boolean;
  /** TalkBack-style accessibility state is detected before the element search. */
  readonly detectsAccessibilityBeforeSearch: boolean;
  /** The accessibility hierarchy is refreshed before the element search. */
  readonly refreshesAccessibilityHierarchyBeforeSearch: boolean;
  /** A cached tap target is revalidated against a fresh hierarchy before tapping. */
  readonly revalidatesCachedTargets: boolean;
  /** Accessibility state detected for an earlier tap can be reused. */
  readonly canReuseAccessibilityState: boolean;
  /** A cached target needs a fresh extraction, not a cached hierarchy, to revalidate. */
  readonly requiresFreshExtractionForCachedTarget: boolean;
  /** Element selection accounts for the panels of a multi-panel device. */
  readonly panelAwareSelection: boolean;
}

const TRAITS: Readonly<Record<AndroidOrIosPlatform, TapPlatformTraits>> = {
  android: {
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
  },
  ios: {
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
  },
};

/** A platform outside the table (e.g. watchOS): no dispatch ladder and no platform-specific behavior. */
const UNSUPPORTED: TapPlatformTraits = {
  tapDispatch: undefined,
  androidLinkActivation: false,
  iosLinkActivation: false,
  capturedOwnerIdentity: false,
  routesAndroidDisplay: false,
  detectsAccessibilityBeforeSearch: false,
  refreshesAccessibilityHierarchyBeforeSearch: false,
  revalidatesCachedTargets: false,
  canReuseAccessibilityState: true,
  requiresFreshExtractionForCachedTarget: false,
  panelAwareSelection: false,
};

export function tapPlatformTraits(platform: string): TapPlatformTraits {
  return isAndroidOrIosPlatform(platform) ? TRAITS[platform] : UNSUPPORTED;
}
