package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.ui.input.key.Key
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyModifiers
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardKey
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

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
}
