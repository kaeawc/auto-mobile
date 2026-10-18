import type { ViewHierarchyAndroidCtrlProxy } from "../../src/features/observe/android/ViewHierarchyAndroidCtrlProxy";

/**
 * Typed ViewHierarchy CtrlProxy double: fills the required members with inert
 * defaults and lets a test override only what it exercises, so no cast to the
 * concrete client is needed.
 */
export function makeViewHierarchyCtrlProxy(
  overrides: Partial<ViewHierarchyAndroidCtrlProxy> = {},
): ViewHierarchyAndroidCtrlProxy {
  return {
    getAccessibilityHierarchy: async () => null,
    setRecompositionTrackingEnabled: async () => {},
    getSdkScreenIdentity: () => undefined,
    ...overrides,
  };
}
