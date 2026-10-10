package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.accessibility.AccessibilityWindowInfo

/**
 * How far the on-screen keyboard reaches up from the bottom of a display, in px; 0 when it is
 * hidden or unknown (#10262). A bottom sheet window rides this offset so it sits above the keyboard
 * while the keyboard is shown, and returns when it hides.
 *
 * Why the accessibility window list and not the prototype window's own `WindowInsets.Type.ime()`:
 * the prototype windows are `TYPE_ACCESSIBILITY_OVERLAY` windows that are not the input-method
 * target (non-focusable unless a text field is visible, and even then only the field's own sheet).
 * The platform dispatches the IME inset only to the window that is the IME target, so a sheet over
 * another app's text field would read an IME inset of 0 whatever the keyboard is doing. The service
 * sees every window, including the input-method window and its bounds, so that is the one source
 * that is right whichever app owns the focused field.
 *
 * The platform emits no per-frame values for this source, so the window position jumps to the new
 * offset instead of following the keyboard's own slide animation; with motion unavailable there is
 * nothing for `motion: "none"` to switch off.
 */
fun interface PrototypeImeInset {
  fun liftPx(displayId: Int): Int
}

object NoPrototypeImeInset : PrototypeImeInset {
  override fun liftPx(displayId: Int) = 0
}

/** The facts about one accessibility window that locate the keyboard. */
internal data class PrototypeImeWindow(val type: Int, val top: Int, val bottom: Int)

/**
 * Pixels between the keyboard's top edge and [screenBottomPx]: the topmost input-method window with
 * non-empty bounds that reaches into the screen. Anything else is 0.
 */
internal fun imeLiftPx(windows: List<PrototypeImeWindow>, screenBottomPx: Int): Int {
  val top =
    windows
      .filter { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD && it.bottom > it.top }
      .minOfOrNull { it.top } ?: return 0
  return (screenBottomPx - top).coerceAtLeast(0)
}

/**
 * The offset a placement's window takes from [liftPx]. Only a bottom sheet rides the keyboard:
 * fullscreen already fills the screen, floating windows stay where their spec put them, and
 * top/side sheets are not anchored to the bottom edge.
 */
internal fun prototypeImeShiftPx(placement: PrototypePlacement, liftPx: Int): Int =
  if (placement is PrototypePlacement.Sheet && placement.edge == PrototypePlacement.Edge.BOTTOM)
    liftPx.coerceAtLeast(0)
  else 0
