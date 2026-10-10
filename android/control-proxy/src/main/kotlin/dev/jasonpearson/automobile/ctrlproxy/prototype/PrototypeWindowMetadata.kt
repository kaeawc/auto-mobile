package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.accessibility.AccessibilityWindowInfo
import androidx.compose.ui.graphics.Color
import dev.jasonpearson.automobile.protocol.PrototypeAppearance
import dev.jasonpearson.automobile.protocol.PrototypeDimension

/**
 * Window title of the prototype (`prototypeLayoutParams`). It is what tells the prototype window
 * apart from CtrlProxy's other accessibility-overlay window, the highlight overlay, which shares
 * the type and the package.
 */
const val PROTOTYPE_WINDOW_TITLE = "AutoMobile Prototype"

/**
 * What the hierarchy capture says about how much of the app the active prototype hides
 * (`prototype_window_metadata_v1`). [placement] is `fullscreen`, `sheet` or `floating`. [opaque] is
 * true only when nothing of the app can show through the prototype's own pixels.
 */
data class PrototypeWindowMetadata(
  val placement: String,
  val opaque: Boolean,
  /** The mode the window is drawn in; null when it was not derived from a controller show. */
  val appearance: PrototypeAppearance? = null,
)

/**
 * Whether the host's own dismiss bar, drawn above the spec in every fullscreen window, is fully
 * opaque. It is a translucent strip (`prototypeDismissColors`), so app pixels show through it and a
 * fullscreen window can never claim to hide the whole app. Flip this only if the bar becomes
 * opaque.
 */
const val FULLSCREEN_DISMISS_BAR_OPAQUE = false

/**
 * Derived from the render model the window actually draws. Opaque requires the window not to be
 * translucent (`opacityPercent` 100), no translucent host chrome over the window, and a fully
 * opaque surface that fills the window: the root's own background at alpha 1 sized to fill with no
 * node alpha, or, for fullscreen, a fully opaque scrim painted behind it. A modal sheet's scrim is
 * drawn over content and never makes anything more opaque. Colours are resolved as they are drawn,
 * against [palettes]: a role name counts when its scheme colour is opaque, a `{light, dark}` pair
 * only when the side for each palette's mode is, and the `scrim` role in a scrim slot never does,
 * because it is drawn at the default scrim opacity. The controller passes the one palette of the
 * mode the show resolved to, with that [appearance]; without it every mode the spec can resolve to
 * is checked.
 */
internal fun prototypeWindowMetadata(
  model: PrototypeRenderModel,
  dismissBarOpaque: Boolean = FULLSCREEN_DISMISS_BAR_OPAQUE,
  palettes: List<PrototypePalette>? = null,
  appearance: PrototypeAppearance? = null,
): PrototypeWindowMetadata {
  val placement = model.placement
  val name =
    when (placement) {
      is PrototypePlacement.Fullscreen -> "fullscreen"
      is PrototypePlacement.Sheet -> "sheet"
      is PrototypePlacement.Floating -> "floating"
    }
  val style = model.root.style
  // What is drawn decides: a colour is solid only if it resolves opaque in every reachable mode.
  val drawn = palettes ?: prototypeReachablePalettes(model)
  fun opaque(color: Color?) = (color?.alpha ?: 0f) >= 1f
  // An omitted dimension is wrap-content, so only an explicit fill spans the window.
  val rootFills =
    style.source.width == PrototypeDimension.Fill && style.source.height == PrototypeDimension.Fill
  val rootSolid =
    rootFills &&
      drawn.all {
        opaque(prototypeResolveColor(it, style.background, style.source.background))
      } &&
      (style.source.alpha?.let { it >= 1.0 } ?: true)
  val fullscreen = placement as? PrototypePlacement.Fullscreen
  val scrimSolid =
    fullscreen != null &&
      drawn.all { opaque(prototypeResolveScrim(it, fullscreen.scrim, fullscreen.scrimSpec)) }
  val chromeOpaque = placement !is PrototypePlacement.Fullscreen || dismissBarOpaque
  return PrototypeWindowMetadata(
    name,
    model.opacityPercent == 100 && chromeOpaque && (rootSolid || scrimSolid),
    appearance,
  )
}

/**
 * Whether an accessibility window type can be one of CtrlProxy's prototype windows: the system
 * layer's accessibility overlay, or the app layer's TYPE_APPLICATION_OVERLAY window, which
 * accessibility reports as [AccessibilityWindowInfo.TYPE_SYSTEM] (#10544).
 */
fun isPrototypeWindowType(windowType: Int): Boolean =
  windowType == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY ||
    windowType == AccessibilityWindowInfo.TYPE_SYSTEM

/**
 * Whether a captured window carries the prototype's type and title. The title is set only by
 * `prototypeLayoutParams`, so it tells the prototype apart from the highlight prototype (same type
 * and package) and from SystemUI's type-3 windows (shade, status bar).
 */
fun hasPrototypeTitle(windowType: Int, title: CharSequence?): Boolean =
  isPrototypeWindowType(windowType) && title?.toString() == PROTOTYPE_WINDOW_TITLE

/**
 * Whether a captured accessibility window is the prototype: a window of either prototype layer that
 * is CtrlProxy's own (its root reports our package) and carries the interactive prototype's title,
 * so the highlight overlay and SystemUI windows are never mistaken for it.
 */
fun isPrototypeWindow(
  windowType: Int,
  title: CharSequence?,
  windowPackage: String?,
  ownPackage: String?,
): Boolean =
  hasPrototypeTitle(windowType, title) && ownPackage != null && windowPackage == ownPackage
