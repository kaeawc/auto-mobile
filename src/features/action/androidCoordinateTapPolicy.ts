import type { Element } from "../../models";

/**
 * Android packages whose list/grid item rows are activated by DIRECT touch
 * handling (a RecyclerView `OnItemTouchListener` / `GestureDetector` and the
 * `androidx.recyclerview.selection` library) rather than by a per-row
 * `OnClickListener`.
 *
 * The CtrlProxy accessibility service dispatches taps via
 * `AccessibilityService.dispatchGesture` (a short synthetic gesture). For these
 * packages the framework *acknowledges* that gesture — the completion callback
 * fires, so `requestTapCoordinates` reports `success: true` — yet the row is
 * neither opened nor selected: the synthetic gesture never reaches the
 * touch-exploration/selection pipeline the way a real hardware touch event
 * does (issue #6335, same failure class as the acknowledged-but-ineffective
 * dispatch in #5910).
 *
 * A real coordinate gesture through the input pipeline
 * (`adb shell input touchscreen tap`) DOES activate these rows, so tapOn must
 * route coordinate taps on these targets through ADB input instead of trusting
 * the acknowledged-but-ineffective dispatchGesture.
 *
 * DocumentsUI ships under several package names across AOSP and Google builds.
 */
const DISPATCH_GESTURE_UNRELIABLE_PACKAGES: ReadonlySet<string> = new Set([
  "com.android.documentsui",
  "com.google.android.documentsui",
]);

/**
 * Resolve the owning Android package of an element, preferring the explicit
 * `package` attribute and falling back to the `<package>:id/<name>` prefix of
 * its `resource-id`. Returns `undefined` when neither is present.
 */
export function androidPackageOfElement(element: Element): string | undefined {
  const pkg = element.package;
  if (typeof pkg === "string" && pkg.length > 0) {
    return pkg;
  }
  const resourceId = element["resource-id"];
  if (typeof resourceId === "string") {
    const idIndex = resourceId.indexOf(":id/");
    if (idIndex > 0) {
      return resourceId.slice(0, idIndex);
    }
  }
  return undefined;
}

/**
 * Whether a coordinate tap on `element` must be issued through the real ADB
 * input pipeline instead of the CtrlProxy `dispatchGesture` path, because the
 * owning app (DocumentsUI, #6335) acknowledges the synthetic gesture without
 * acting on it.
 */
export function androidCoordinateTapRequiresAdbInput(element: Element): boolean {
  const pkg = androidPackageOfElement(element);
  return pkg !== undefined && DISPATCH_GESTURE_UNRELIABLE_PACKAGES.has(pkg);
}
