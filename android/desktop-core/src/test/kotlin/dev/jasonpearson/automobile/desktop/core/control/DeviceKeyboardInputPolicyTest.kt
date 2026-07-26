package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.DeviceKeyModifiers
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardInputPolicy
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardKey
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardRejection
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The pure client-side keyboard-forwarding policy (issue #3351).
 *
 * The chord rule is pinned from BOTH directions, because it can fail either way: too loose and the
 * client swallows the host's menu accelerators, too strict and control mode cannot type a capital
 * letter.
 */
class DeviceKeyboardInputPolicyTest {

  @Test
  fun `escape presses the device back button`() {
    // Escape is the only key bound to a device BUTTON, and it goes to pressButton (supported on
    // both platforms) rather than to the daemon's `escape` key name.
    assertEquals(
      DeviceKeyboardDecision.PressButton("back"),
      DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(key = DeviceKeyboardKey.Escape)),
    )
  }

  @Test
  fun `device-meaningful keys map to the daemon's key vocabulary`() {
    val expected =
      mapOf(
        DeviceKeyboardKey.Enter to "enter",
        DeviceKeyboardKey.Tab to "tab",
        DeviceKeyboardKey.Backspace to "backspace",
        DeviceKeyboardKey.Delete to "delete",
        DeviceKeyboardKey.ArrowUp to "arrow_up",
        DeviceKeyboardKey.ArrowDown to "arrow_down",
        DeviceKeyboardKey.ArrowLeft to "arrow_left",
        DeviceKeyboardKey.ArrowRight to "arrow_right",
      )
    // Pinned against the daemon's own names in src/features/action/InputKey.ts. A typo here would
    // reach the device as an unknown key rather than as a compile error.
    expected.forEach { (key, name) ->
      assertEquals(
        DeviceKeyboardDecision.SendKey(name),
        DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(key = key)),
        "$key",
      )
    }
  }

  @Test
  fun `a mapped key wins over whatever character it produced`() {
    // Hosts report '\n' for Enter and '\t' for Tab. Typing those as TEXT would put a literal
    // newline in the device's text field instead of pressing the key.
    assertEquals(
      DeviceKeyboardDecision.SendKey("enter"),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(key = DeviceKeyboardKey.Enter, character = '\n')
      ),
    )
    // And the precedence is the KEY's, not an accident of those characters happening to be
    // untypable: a host that reports a printable character alongside a device key — a remapped
    // keyboard, a non-US layout, a toolkit that fills the field in for every keystroke — must still
    // press the key rather than type the letter.
    assertEquals(
      DeviceKeyboardDecision.SendKey("arrow_left"),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(key = DeviceKeyboardKey.ArrowLeft, character = 'q')
      ),
    )
  }

  @Test
  fun `a printable character is typed`() {
    assertEquals(
      DeviceKeyboardDecision.TypeText("a"),
      DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(character = 'a')),
    )
  }

  @Test
  fun `shift is not a chord modifier, so capitals still type`() {
    // The too-STRICT direction of the chord rule: folding Shift in with Ctrl/Alt/Meta would make
    // control mode unable to type a capital letter or any shifted symbol.
    assertEquals(
      DeviceKeyboardDecision.TypeText("A"),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(character = 'A', modifiers = DeviceKeyModifiers(shift = true))
      ),
    )
  }

  @Test
  fun `every chord modifier keeps the keystroke with the host`() {
    // The too-LOOSE direction. Stated per-modifier so a rule that only checked, say, Meta would
    // fail here on Linux/Windows-style Ctrl accelerators.
    val chords =
      listOf(
        DeviceKeyModifiers(ctrl = true),
        DeviceKeyModifiers(alt = true),
        DeviceKeyModifiers(meta = true),
      )
    chords.forEach { modifiers ->
      assertEquals(
        DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
        DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(character = 's', modifiers = modifiers)),
        "$modifiers",
      )
    }
  }

  @Test
  fun `a chord on a mapped key is still the host's`() {
    // Cmd-Escape / Ctrl-Escape are host chords on real desktops, so the fact that bare Escape has a
    // device meaning must not promote the chord.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(
          key = DeviceKeyboardKey.Escape,
          modifiers = DeviceKeyModifiers(meta = true),
        )
      ),
    )
  }

  @Test
  fun `an explicitly listed chord key forwards`() {
    // The documented escape hatch: a client that knows its host leaves a chord unclaimed opts that
    // key in. Empty by default, so this is the only way a chord ever reaches the device.
    assertEquals(
      DeviceKeyboardDecision.PressButton("back"),
      DeviceKeyboardInputPolicy.evaluate(
        stroke =
          DeviceKeyStroke(
            key = DeviceKeyboardKey.Escape,
            modifiers = DeviceKeyModifiers(meta = true),
          ),
        forwardedChordKeys = setOf(DeviceKeyboardKey.Escape),
      ),
    )
  }

  @Test
  fun `an unmapped key with no character is ignored`() {
    // A function key, a modifier pressed alone, a dead key: nothing is sent, and the caller leaves
    // the event unconsumed so the host can still use it.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.Unsupported),
      DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke()),
    )
  }

  @Test
  fun `control characters are never typed as text`() {
    // Hosts report a control character for several unmapped keys. Typing one would insert an
    // invisible control byte into whatever field has device focus.
    listOf('\u0000', '\u0001', '\b', '\u001B', '\uFFFF').forEach { character ->
      assertEquals(
        DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.Unsupported),
        DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(character = character)),
        "U+${character.code.toString(radix = 16)}",
      )
    }
  }
}
