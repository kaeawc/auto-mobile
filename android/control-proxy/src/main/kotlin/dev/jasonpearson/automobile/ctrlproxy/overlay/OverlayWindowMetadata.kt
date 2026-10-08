package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.accessibility.AccessibilityWindowInfo
import dev.jasonpearson.automobile.protocol.OverlayDimension

/**
 * Window title of the interactive overlay (`interactiveOverlayLayoutParams`). It is what tells the
 * interactive overlay window apart from CtrlProxy's other accessibility-overlay window, the
 * highlight overlay, which shares the type and the package.
 */
const val INTERACTIVE_OVERLAY_WINDOW_TITLE = "AutoMobile Interactive Overlay"

/**
 * What the hierarchy capture says about how much of the app the active interactive overlay hides
 * (`overlay_window_metadata_v1`). [placement] is `fullscreen`, `sheet` or `floating`. [opaque] is
 * true only when nothing of the app can show through the overlay's own pixels.
 */
data class OverlayWindowMetadata(val placement: String, val opaque: Boolean)

/**
 * Whether the host's own dismiss bar, drawn above the spec in every fullscreen window, is fully
 * opaque. It is a translucent strip (`overlayDismissColors`), so app pixels show through it and a
 * fullscreen window can never claim to hide the whole app. Flip this only if the bar becomes
 * opaque.
 */
const val FULLSCREEN_DISMISS_BAR_OPAQUE = false

/**
 * Derived from the render model the window actually draws. Opaque requires the window not to be
 * translucent (`opacityPercent` 100), no translucent host chrome over the window, and a fully
 * opaque surface that fills the window: the root's own background at alpha 1 sized to fill with no
 * node alpha, or, for fullscreen, a fully opaque scrim painted behind it. A modal sheet's scrim is
 * drawn over content and never makes anything more opaque.
 */
fun overlayWindowMetadata(
  model: OverlayRenderModel,
  dismissBarOpaque: Boolean = FULLSCREEN_DISMISS_BAR_OPAQUE,
): OverlayWindowMetadata {
  val placement = model.placement
  val name =
    when (placement) {
      is OverlayPlacement.Fullscreen -> "fullscreen"
      is OverlayPlacement.Sheet -> "sheet"
      is OverlayPlacement.Floating -> "floating"
    }
  val style = model.root.style
  // An omitted dimension is wrap-content, so only an explicit fill spans the window.
  val rootFills =
    style.source.width == OverlayDimension.Fill && style.source.height == OverlayDimension.Fill
  val rootSolid =
    rootFills &&
      (style.background?.alpha ?: 0f) >= 1f &&
      (style.source.alpha?.let { it >= 1.0 } ?: true)
  val scrimSolid = (placement as? OverlayPlacement.Fullscreen)?.scrim?.alpha == 1f
  val chromeOpaque = placement !is OverlayPlacement.Fullscreen || dismissBarOpaque
  return OverlayWindowMetadata(
    name,
    model.opacityPercent == 100 && chromeOpaque && (rootSolid || scrimSolid),
  )
}

/**
 * Whether a captured accessibility window is the interactive overlay: an accessibility-overlay
 * window that is CtrlProxy's own (its root reports our package) and carries the interactive
 * overlay's title, so the highlight overlay is never mistaken for it.
 */
fun isInteractiveOverlayWindow(
  windowType: Int,
  title: CharSequence?,
  windowPackage: String?,
  ownPackage: String?,
): Boolean =
  windowType == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY &&
    ownPackage != null &&
    windowPackage == ownPackage &&
    title?.toString() == INTERACTIVE_OVERLAY_WINDOW_TITLE
