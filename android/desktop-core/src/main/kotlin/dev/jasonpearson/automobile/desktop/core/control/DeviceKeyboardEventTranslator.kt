package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEvent
import androidx.compose.ui.input.key.isAltPressed
import androidx.compose.ui.input.key.isCtrlPressed
import androidx.compose.ui.input.key.isMetaPressed
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.utf16CodePoint
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyModifiers
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardKey

/** Whether this host is macOS. Resolved once; the composition rule below branches on it. */
private val IS_MAC = System.getProperty("os.name", "").contains("Mac", ignoreCase = true)

/**
 * Translates a Compose key event into the Compose-free [DeviceKeyStroke] that
 * [dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardInputPolicy] decides on (issue
 * [#3351](https://github.com/kaeawc/auto-mobile/issues/3351)).
 *
 * This is the only place in the keyboard path that knows about Compose. Keeping the toolkit
 * vocabulary here — rather than in the policy — is what lets a third-party client in another host
 * (or another language) reuse the policy verbatim while supplying its own translation, exactly as
 * `DeviceScreenCoordinateMapper`/`DeviceDragGesturePolicy` split the Compose gesture from the pure
 * rule.
 *
 * The [translate] overload taking primitives exists so the mapping is unit-testable without
 * constructing a native key event (a Compose desktop [KeyEvent] wraps an AWT event, which needs a
 * real `Component`).
 */
object DeviceKeyboardEventTranslator {

  /**
   * Compose keys that carry a device meaning of their own. Everything absent here translates to a
   * stroke with a null key, which the policy then judges purely on the character it produced.
   *
   * `NumPadEnter` folds onto [DeviceKeyboardKey.Enter]: the numeric keypad's Enter is the same
   * intent as the main one, and the daemon has one `enter` key name.
   */
  private val DEVICE_KEYS: Map<Key, DeviceKeyboardKey> =
    mapOf(
      Key.Escape to DeviceKeyboardKey.Escape,
      Key.Enter to DeviceKeyboardKey.Enter,
      Key.NumPadEnter to DeviceKeyboardKey.Enter,
      Key.Tab to DeviceKeyboardKey.Tab,
      Key.Backspace to DeviceKeyboardKey.Backspace,
      Key.Delete to DeviceKeyboardKey.Delete,
      Key.DirectionUp to DeviceKeyboardKey.ArrowUp,
      Key.DirectionDown to DeviceKeyboardKey.ArrowDown,
      Key.DirectionLeft to DeviceKeyboardKey.ArrowLeft,
      Key.DirectionRight to DeviceKeyboardKey.ArrowRight,
    )

  /** Translate a live Compose [event]. */
  fun translate(event: KeyEvent): DeviceKeyStroke =
    translate(
      key = event.key,
      utf16CodePoint = event.utf16CodePoint,
      modifiers =
        DeviceKeyModifiers(
          ctrl = event.isCtrlPressed,
          alt = event.isAltPressed,
          meta = event.isMetaPressed,
          shift = event.isShiftPressed,
        ),
    )

  /**
   * Translate the parts of a key event the policy needs.
   *
   * [utf16CodePoint] is Compose's report of the character the keystroke produced. Only the Basic
   * Multilingual Plane is carried through as a [Char]: a supplementary code point cannot be
   * expressed as one `Char`, and typing half a surrogate pair would corrupt the text. Such a code
   * point yields a null character, so the policy ignores the keystroke rather than mangling it —
   * multi-unit input is IME territory, explicitly out of scope for #3351.
   *
   * @param isMac the host platform, injectable so the composition rule below is unit-testable
   *   without a real `os.name`; defaults to this host.
   */
  fun translate(
    key: Key,
    utf16CodePoint: Int,
    modifiers: DeviceKeyModifiers,
    isMac: Boolean = IS_MAC,
  ): DeviceKeyStroke =
    DeviceKeyStroke(
      key = DEVICE_KEYS[key],
      character =
        utf16CodePoint.takeIf { it in Char.MIN_VALUE.code..Char.MAX_VALUE.code }?.toChar(),
      modifiers = modifiers,
      altComposesText = resolvesAltComposition(modifiers, isMac),
    )

  /**
   * Whether these modifiers are an Alt-family **character composition** on this platform, rather
   * than a menu/window accelerator. This is the platform decision the pure policy cannot make; it
   * lives here because only the toolkit adapter sees the host OS and AWT's modifier masks.
   *
   * - **Windows/Linux:** composition is AltGr, which AWT surfaces as **Ctrl+Alt**. A plain `Alt`
   *   (no Ctrl) is a menu accelerator (`Alt+F` → File) — and AWT still reports a printable keyChar
   *   for it — so it must NOT count as composition or the canvas would swallow the host's mnemonic.
   * - **macOS:** composition is the **Option** key (plain Alt, no Ctrl) — Option+L = `@` — and
   *   macOS menus use Cmd/Meta, never Alt, so plain Alt is safe to treat as composition there.
   *
   * Meta always disqualifies: `Cmd`/`Meta` shortcuts never compose characters, so Meta-held is the
   * reliable "shortcut, not typing" signal on every platform.
   */
  private fun resolvesAltComposition(modifiers: DeviceKeyModifiers, isMac: Boolean): Boolean {
    if (modifiers.meta || !modifiers.alt) return false
    return isMac || modifiers.ctrl
  }
}
