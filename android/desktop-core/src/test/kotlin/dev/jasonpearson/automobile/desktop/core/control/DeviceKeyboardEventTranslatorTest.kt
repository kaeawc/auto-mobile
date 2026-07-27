package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.ui.input.key.Key
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyModifiers
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardInputPolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardKey
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardRejection
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Compose->domain half of keyboard forwarding (issue #3351): which toolkit keys carry a device
 * meaning, and which code points survive as a typable character.
 */
class DeviceKeyboardEventTranslatorTest {

  private fun translate(key: Key, codePoint: Int = 0) =
    DeviceKeyboardEventTranslator.translate(key, codePoint, DeviceKeyModifiers())

  @Test
  fun `device-meaningful compose keys translate to their domain key`() {
    val expected =
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
    expected.forEach { (key, domainKey) -> assertEquals(domainKey, translate(key).key, "$key") }
  }

  @Test
  fun `an ordinary letter carries no device key, only its character`() {
    // The policy must judge a letter purely on the character it produced; giving it a device key
    // would route it away from typeText.
    val stroke = translate(Key.A, codePoint = 'a'.code)
    assertNull(stroke.key)
    assertEquals('a', stroke.character)
  }

  @Test
  fun `a supplementary code point yields no character`() {
    // An emoji cannot be expressed as one Char; typing half a surrogate pair would corrupt the
    // text, so the keystroke is dropped instead. Multi-unit input is IME territory (out of scope).
    assertNull(translate(Key.A, codePoint = 0x1F600).character)
  }

  @Test
  fun `modifiers are carried through unchanged`() {
    val modifiers = DeviceKeyModifiers(ctrl = true, alt = false, meta = true, shift = true)
    assertEquals(
      modifiers,
      DeviceKeyboardEventTranslator.translate(Key.S, 's'.code, modifiers).modifiers,
    )
  }

  // The platform-aware Alt-composition resolution (issue #3351). This is where the host OS is
  // known, so it — not the pure policy — decides whether an Alt-family keystroke composed a
  // character or is a menu accelerator. `alt && printable` alone cannot tell them apart, because on
  // Windows/Linux AWT reports a printable keyChar for a plain Alt+F accelerator too.

  private fun resolvedAltComposition(modifiers: DeviceKeyModifiers, isMac: Boolean): Boolean =
    DeviceKeyboardEventTranslator.translate(Key.A, 'x'.code, modifiers, isMac).altComposesText

  @Test
  fun `on Windows or Linux only Ctrl+Alt is composition, plain Alt is a menu accelerator`() {
    // Restores the original AltGr shape: AltGr surfaces as Ctrl+Alt, so that composes; a plain Alt
    // is Alt+F-style menu access and must NOT be treated as composition.
    assertTrue(
      resolvedAltComposition(DeviceKeyModifiers(ctrl = true, alt = true), isMac = false),
      "AltGr (Ctrl+Alt) composes on Windows/Linux",
    )
    assertFalse(
      resolvedAltComposition(DeviceKeyModifiers(alt = true), isMac = false),
      "plain Alt is a menu accelerator on Windows/Linux, not composition",
    )
  }

  @Test
  fun `on macOS plain Alt (Option) is composition`() {
    // macOS menus use Cmd/Meta, never Alt, so the Option key (plain Alt) is free to compose.
    assertTrue(
      resolvedAltComposition(DeviceKeyModifiers(alt = true), isMac = true),
      "Option (plain Alt) composes on macOS",
    )
  }

  @Test
  fun `Meta disqualifies composition on every platform`() {
    assertFalse(resolvedAltComposition(DeviceKeyModifiers(alt = true, meta = true), isMac = true))
    assertFalse(
      resolvedAltComposition(
        DeviceKeyModifiers(ctrl = true, alt = true, meta = true),
        isMac = false,
      )
    )
  }

  // End-to-end (translator -> policy), which is what the acceptance criterion "host shortcuts are
  // not swallowed" actually turns on. Parameterized by isMac so both platforms are deterministic.

  private fun decideForChar(
    codePoint: Int,
    modifiers: DeviceKeyModifiers,
    isMac: Boolean,
  ): DeviceKeyboardDecision {
    val stroke: DeviceKeyStroke =
      DeviceKeyboardEventTranslator.translate(Key.A, codePoint, modifiers, isMac)
    return DeviceKeyboardInputPolicy.evaluate(stroke)
  }

  @Test
  fun `Windows Alt+F stays with the host instead of typing f into the device`() {
    // THE regression: a plain Alt+F reports a printable 'f' on Windows/Linux; if that were treated
    // as composition the canvas would type 'f' and the host would never open its File menu.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      decideForChar('f'.code, DeviceKeyModifiers(alt = true), isMac = false),
    )
  }

  @Test
  fun `Windows AltGr composed character types on the device`() {
    assertEquals(
      DeviceKeyboardDecision.TypeText("@"),
      decideForChar('@'.code, DeviceKeyModifiers(ctrl = true, alt = true), isMac = false),
    )
  }

  @Test
  fun `macOS Option composed character types on the device`() {
    assertEquals(
      DeviceKeyboardDecision.TypeText("@"),
      decideForChar('@'.code, DeviceKeyModifiers(alt = true), isMac = true),
    )
  }

  @Test
  fun `macOS Cmd chord stays with the host`() {
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      decideForChar('s'.code, DeviceKeyModifiers(meta = true), isMac = true),
    )
  }
}
