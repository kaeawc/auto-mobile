package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.domain.DeviceChordAllowance
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
    // fail here on Linux/Windows-style Ctrl accelerators. Ctrl and Meta are chords even when a
    // printable character is reported alongside — only Alt composes text (see the Option tests).
    listOf(DeviceKeyModifiers(ctrl = true), DeviceKeyModifiers(meta = true)).forEach { modifiers ->
      assertEquals(
        DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
        DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(character = 's', modifiers = modifiers)),
        "$modifiers",
      )
    }
    // Alt is a chord ONLY when it did not compose a character — a real Alt accelerator / mnemonic
    // reports no printable character. Alt WITH a composed character is macOS Option typing, covered
    // separately; so the Alt chord case is pinned with the no-character shape it actually takes.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(character = null, modifiers = DeviceKeyModifiers(alt = true))
      ),
    )
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
        forwardedChords = setOf(DeviceChordAllowance.OfKey(DeviceKeyboardKey.Escape, meta = true)),
      ),
    )
  }

  @Test
  fun `a printable chord can be opted in by its character`() {
    // The chords a client actually wants to opt in are letter chords like Ctrl-S — and an ordinary
    // letter deliberately carries no device key, so a key-only allowlist could never name one. It
    // must match on the character.
    val ctrlS = DeviceKeyStroke(character = 's', modifiers = DeviceKeyModifiers(ctrl = true))
    assertEquals(
      DeviceKeyboardDecision.TypeText("s"),
      DeviceKeyboardInputPolicy.evaluate(
        stroke = ctrlS,
        forwardedChords = setOf(DeviceChordAllowance.OfCharacter('s', ctrl = true)),
      ),
    )
    // Case-insensitive, so opting "Ctrl-S" in does not require enumerating Ctrl-Shift-S too.
    assertEquals(
      DeviceKeyboardDecision.TypeText("S"),
      DeviceKeyboardInputPolicy.evaluate(
        stroke =
          DeviceKeyStroke(
            character = 'S',
            modifiers = DeviceKeyModifiers(ctrl = true, shift = true),
          ),
        forwardedChords = setOf(DeviceChordAllowance.OfCharacter('s', ctrl = true)),
      ),
    )
    // And opting one chord in must not open the gate for every other chord.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        stroke = DeviceKeyStroke(character = 'q', modifiers = DeviceKeyModifiers(ctrl = true)),
        forwardedChords = setOf(DeviceChordAllowance.OfCharacter('s', ctrl = true)),
      ),
    )
  }

  @Test
  fun `a character opt-in is scoped to its exact modifier set`() {
    // The bug this guards: an OfCharacter('s', ctrl) opt-in must forward Ctrl-S ONLY, never the
    // host's Meta-S (save) or Alt-S (menu) on the same letter. Comparing character alone would
    // swallow all three.
    val ctrlSOptIn = setOf(DeviceChordAllowance.OfCharacter('s', ctrl = true))
    assertEquals(
      DeviceKeyboardDecision.TypeText("s"),
      DeviceKeyboardInputPolicy.evaluate(
        stroke = DeviceKeyStroke(character = 's', modifiers = DeviceKeyModifiers(ctrl = true)),
        forwardedChords = ctrlSOptIn,
      ),
      "Ctrl-S is the opted-in chord and forwards",
    )
    listOf(DeviceKeyModifiers(meta = true), DeviceKeyModifiers(alt = true)).forEach { mods ->
      assertEquals(
        DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
        DeviceKeyboardInputPolicy.evaluate(
          stroke = DeviceKeyStroke(character = 's', modifiers = mods),
          forwardedChords = ctrlSOptIn,
        ),
        "$mods-S is a different host shortcut and must NOT be forwarded by a Ctrl-S opt-in",
      )
    }
  }

  @Test
  fun `a key opt-in is scoped to its exact modifier set`() {
    // Same scoping for OfKey: opting Meta-Escape in must not forward Ctrl-Escape or Alt-Escape.
    val metaEscapeOptIn = setOf(DeviceChordAllowance.OfKey(DeviceKeyboardKey.Escape, meta = true))
    assertEquals(
      DeviceKeyboardDecision.PressButton("back"),
      DeviceKeyboardInputPolicy.evaluate(
        stroke =
          DeviceKeyStroke(
            key = DeviceKeyboardKey.Escape,
            modifiers = DeviceKeyModifiers(meta = true),
          ),
        forwardedChords = metaEscapeOptIn,
      ),
    )
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        stroke =
          DeviceKeyStroke(
            key = DeviceKeyboardKey.Escape,
            modifiers = DeviceKeyModifiers(ctrl = true),
          ),
        forwardedChords = metaEscapeOptIn,
      ),
    )
    // Alt-Escape too: the contract requires it to stay host-handled, so an accidental Alt allowance
    // (or a match that ignored alt) cannot regress unnoticed.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        stroke =
          DeviceKeyStroke(
            key = DeviceKeyboardKey.Escape,
            modifiers = DeviceKeyModifiers(alt = true),
          ),
        forwardedChords = metaEscapeOptIn,
      ),
    )
  }

  @Test
  fun `opting in nothing forwards no chord`() {
    // The default: an empty allowlist leaves every chord with the host.
    listOf(
        DeviceKeyStroke(character = 's', modifiers = DeviceKeyModifiers(ctrl = true)),
        DeviceKeyStroke(character = 's', modifiers = DeviceKeyModifiers(meta = true)),
        DeviceKeyStroke(
          key = DeviceKeyboardKey.Escape,
          modifiers = DeviceKeyModifiers(ctrl = true),
        ),
      )
      .forEach { stroke ->
        assertEquals(
          DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
          DeviceKeyboardInputPolicy.evaluate(stroke = stroke, forwardedChords = emptySet()),
          "$stroke",
        )
      }
  }

  @Test
  fun `a host-resolved Alt composition with a typable character types`() {
    // The policy is platform-agnostic: it forwards an Alt-modified keystroke as text ONLY when the
    // host has resolved it as composition (AltGr on Win/Linux, Option on macOS — decided in
    // DeviceKeyboardEventTranslator, covered by DeviceKeyboardEventTranslatorTest). Here the flag
    // is set directly; the character still has to be typable.
    assertEquals(
      DeviceKeyboardDecision.TypeText("@"),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(
          character = '@',
          modifiers = DeviceKeyModifiers(alt = true),
          altComposesText = true,
        )
      ),
    )
  }

  @Test
  fun `an Alt keystroke the host did NOT resolve as composition stays with the host`() {
    // The regression guard (AC: host shortcuts are not swallowed). On Windows/Linux a plain Alt+F
    // menu accelerator reports a printable 'f', but the translator resolves altComposesText=false
    // there, so the policy must keep it with the host rather than typing 'f' into the device.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(
          character = 'f',
          modifiers = DeviceKeyModifiers(alt = true),
          altComposesText = false,
        )
      ),
    )
  }

  @Test
  fun `a resolved composition still stays with the host when its character is untypable`() {
    // A composition of a non-ASCII character (AltGr-EUR) is real, but the daemon's append path
    // cannot type it. The allowance is scoped to typable ASCII, so this is not an allowed chord and
    // remains HostChord — never consumed, never swallowed twice.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(
          character = '€',
          modifiers = DeviceKeyModifiers(alt = true),
          altComposesText = true,
        )
      ),
    )
    // And a resolved composition that produced NO character (a dead key, an accelerator) has
    // nothing to type, so it stays with the host too.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(
          key = DeviceKeyboardKey.ArrowLeft,
          modifiers = DeviceKeyModifiers(alt = true),
          altComposesText = true,
        )
      ),
    )
  }

  @Test
  fun `a real Ctrl-Alt shortcut still stays with the host`() {
    // The other direction of the AltGr allowance, and the one that keeps it from being a hole: a
    // genuine accelerator produces NO printable character, so it must not slip through.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(
          key = DeviceKeyboardKey.ArrowLeft,
          modifiers = DeviceKeyModifiers(ctrl = true, alt = true),
        )
      ),
    )
    // Nor may adding Meta turn a window-manager chord into typing.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(
          character = '@',
          modifiers = DeviceKeyModifiers(ctrl = true, alt = true, meta = true),
        )
      ),
    )
  }

  @Test
  fun `printable text forwards without a platform-specific gate`() {
    assertEquals(
      DeviceKeyboardDecision.TypeText("a"),
      DeviceKeyboardInputPolicy.evaluate(stroke = DeviceKeyStroke(character = 'a')),
    )
    assertEquals(
      DeviceKeyboardDecision.PressButton("back"),
      DeviceKeyboardInputPolicy.evaluate(stroke = DeviceKeyStroke(key = DeviceKeyboardKey.Escape)),
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
  fun `a shifted device key is declined, never delivered as the bare key`() {
    // The daemon's input/key transmits no modifiers (its contract rejects them), so the only
    // deliverable would be the BARE key — a semantically different keystroke. Shift-Tab means
    // focus-backward; sending `tab` would move focus forward. Declined and left unconsumed, so
    // the host (which can honor the shifted form) still receives it.
    listOf(
        DeviceKeyboardKey.Tab,
        DeviceKeyboardKey.Enter,
        DeviceKeyboardKey.ArrowUp,
        DeviceKeyboardKey.ArrowLeft,
        DeviceKeyboardKey.Escape,
      )
      .forEach { key ->
        assertEquals(
          DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.ShiftedKeyUnsupported),
          DeviceKeyboardInputPolicy.evaluate(
            DeviceKeyStroke(key = key, modifiers = DeviceKeyModifiers(shift = true))
          ),
          "$key",
        )
      }
  }

  @Test
  fun `the plain forms of those keys still forward`() {
    // The other direction of the shift rule: declining the shifted form must not cost the plain
    // one, or the mirrored device loses Tab and the arrows entirely.
    assertEquals(
      DeviceKeyboardDecision.SendKey("tab"),
      DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(key = DeviceKeyboardKey.Tab)),
    )
    assertEquals(
      DeviceKeyboardDecision.SendKey("arrow_up"),
      DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(key = DeviceKeyboardKey.ArrowUp)),
    )
    assertEquals(
      DeviceKeyboardDecision.PressButton("back"),
      DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(key = DeviceKeyboardKey.Escape)),
    )
  }

  @Test
  fun `a printable character the daemon cannot type is left with the host`() {
    // The double-loss bug this guards: the daemon's append path types by injecting Android key
    // events from an ASCII-only table, so a non-ASCII character can never reach the device. If the
    // policy consumed it anyway the keystroke would be lost twice — not typed on the device, and
    // not delivered to the host either. Declining keeps the host's copy.
    listOf('é', '€', 'ß', 'あ', '\u00A0').forEach { character ->
      assertEquals(
        DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.CharacterUnsupported),
        DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(character = character)),
        "U+${character.code.toString(radix = 16)}",
      )
    }
  }

  @Test
  fun `every printable ASCII character is still forwarded`() {
    // The other direction, and the reason the refusal above is a range rather than a blocklist:
    // narrowing further would make ordinary punctuation and capitals untypable in control mode.
    // Every character here has an entry in src/features/action/asciiKeyEvents.ts.
    (0x20..0x7E).forEach { code ->
      val character = code.toChar()
      assertEquals(
        DeviceKeyboardDecision.TypeText(character.toString()),
        DeviceKeyboardInputPolicy.evaluate(DeviceKeyStroke(character = character)),
        "U+${code.toString(radix = 16)}",
      )
    }
  }

  @Test
  fun `AltGr composing a non-ASCII character stays with the host`() {
    // The AltGr allowance is scoped to characters the daemon can actually type. AltGr-EUR on a
    // German layout is a real keystroke, but forwarding it would consume the host's copy of an
    // event that can never reach the device, so it is refused as an ordinary Ctrl+Alt chord.
    assertEquals(
      DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord),
      DeviceKeyboardInputPolicy.evaluate(
        DeviceKeyStroke(
          character = '€',
          modifiers = DeviceKeyModifiers(ctrl = true, alt = true),
        )
      ),
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
