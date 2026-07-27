package dev.jasonpearson.automobile.desktop.domain

/**
 * The host-independent identity of a key that means something to a device on its own, as opposed to
 * one that means "type this character".
 *
 * Deliberately small and **not** a mirror of any toolkit's key enum: it lists only the keys
 * [DeviceKeyboardInputPolicy] has a device meaning for. A client translates its own toolkit's key
 * codes into these (the desktop app does it in `DeviceKeyboardEventTranslator`), which is what
 * keeps the policy free of Compose, AWT, or any other host key vocabulary.
 */
public enum class DeviceKeyboardKey {
  Escape,
  Enter,
  Tab,
  Backspace,
  Delete,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
}

/**
 * The modifier keys held during a keystroke.
 *
 * [shift] is separated from the rest on purpose — see [hasChordModifier].
 */
public data class DeviceKeyModifiers(
  val ctrl: Boolean = false,
  val alt: Boolean = false,
  val meta: Boolean = false,
  val shift: Boolean = false,
) {
  /**
   * True when a modifier that makes this keystroke a **host chord** is held.
   *
   * Ctrl, Alt and Meta (Cmd/Win) are the modifiers hosts build their menu accelerators and window
   * shortcuts out of, on every desktop platform. Shift is not one of them: it is part of ordinary
   * typing (it is how a capital letter or a `?` is produced), so treating it as a chord modifier
   * would make control mode unable to type half the characters on the keyboard.
   */
  public val hasChordModifier: Boolean
    get() = ctrl || alt || meta

  /**
   * Whether this modifier set is the shape AltGr takes on layouts that report it as Ctrl+Alt.
   *
   * AltGr is how a great many non-US layouts produce `@`, `€`, `{`, `\` and friends, and several
   * toolkits (AWT among them, which Compose desktop is built on) surface it as Ctrl **and** Alt
   * together rather than as a modifier of its own. Rejecting that shape outright — the obvious
   * reading of "Ctrl/Alt/Meta means host chord" — makes those characters untypable on the layouts
   * most of the world uses.
   *
   * This is only ever consulted together with a printable character (see
   * [DeviceKeyboardInputPolicy.evaluate]), which is what keeps a *real* Ctrl+Alt accelerator with
   * the host: a shortcut chord produces no printable character, so it never takes this branch. Meta
   * is excluded because no layout composes characters with it.
   */
  public val isAltGraphShape: Boolean
    get() = ctrl && alt && !meta
}

/**
 * One keystroke, described without reference to any UI toolkit.
 *
 * @param key the device-meaningful key, or null when the host key has no device meaning of its own
 *   (an ordinary letter, a function key, a modifier pressed alone).
 * @param character the printable character the host says this keystroke produced, or null. Hosts
 *   report control characters here for keys like Enter and Tab; [DeviceKeyboardInputPolicy] filters
 *   those out rather than typing them.
 * @param modifiers the modifiers held at the time.
 */
public data class DeviceKeyStroke(
  val key: DeviceKeyboardKey? = null,
  val character: Char? = null,
  val modifiers: DeviceKeyModifiers = DeviceKeyModifiers(),
)

/**
 * One entry on the explicit chord forward list — the escape hatch to the host-chord rule.
 *
 * Two shapes, because a keystroke has two possible identities and the interesting chords use the
 * second one: a client wanting to opt Ctrl-S in cannot name it by [DeviceKeyboardKey], since an
 * ordinary letter deliberately carries no device key at all. Matching on the produced character is
 * the only way to name it.
 */
public sealed interface DeviceChordAllowance {
  /** Matches a keystroke whose [DeviceKeyStroke.key] is [key]. */
  public data class OfKey(val key: DeviceKeyboardKey) : DeviceChordAllowance

  /**
   * Matches a keystroke whose [DeviceKeyStroke.character] is [character], compared
   * case-insensitively so a client opting in "Ctrl-S" does not have to enumerate Ctrl-Shift-S too.
   */
  public data class OfCharacter(val character: Char) : DeviceChordAllowance
}

/** Why [DeviceKeyboardInputPolicy] declined to forward a keystroke to the device. */
public enum class DeviceKeyboardRejection {
  /**
   * A modifier-bearing chord that is not on the client's explicit forward list. It belongs to the
   * host application, so the client must leave the event **unconsumed**.
   */
  HostChord,

  /**
   * Neither a device-meaningful key nor a printable character (a function key, a modifier pressed
   * alone, a dead key). Nothing is sent and nothing is reported; the event is left unconsumed so
   * the host may still act on it.
   */
  Unsupported,

  /**
   * A printable character on a platform whose daemon text helper can only REPLACE the focused
   * field, not append to it. Typing one character at a time there would wipe the field on every
   * keystroke, so text forwarding is disabled rather than destructive (issue #3351).
   */
  TextUnsupported,

  /**
   * A printable character the daemon's append path cannot type at all — anything outside printable
   * ASCII (`é`, `€`, CJK, emoji).
   *
   * Append types by injecting real Android key events, and the ASCII→keycode table behind it
   * (`src/features/action/asciiKeyEvents.ts`) has no entry for anything else. Forwarding such a
   * character would consume the host keystroke and then fail on the device: lost twice. Declining
   * leaves the event unconsumed, so the host still gets it.
   */
  CharacterUnsupported,
}

/** What [DeviceKeyboardInputPolicy.evaluate] decided one keystroke should send. */
public sealed interface DeviceKeyboardDecision {
  /** Send exactly one `input/pressButton` with this daemon button name. */
  public data class PressButton(val button: String) : DeviceKeyboardDecision

  /** Send exactly one `input/key` with this daemon key name. */
  public data class SendKey(val key: String) : DeviceKeyboardDecision

  /** Send exactly one `input/typeText` with this text. Never empty. */
  public data class TypeText(val text: String) : DeviceKeyboardDecision

  /** Send nothing. [reason] is diagnostic; no daemon request is made and no error is shown. */
  public data class Ignored(val reason: DeviceKeyboardRejection) : DeviceKeyboardDecision
}

/**
 * The **client-side** keyboard-forwarding policy for a mirrored device screen (issue
 * [#3351](https://github.com/kaeawc/auto-mobile/issues/3351)).
 *
 * As with the drag policy, the daemon has no say in any of this: `input/pressButton`,
 * `input/typeText` and `input/key` faithfully execute whatever they are handed, so deciding *which
 * keystrokes reach the device at all* is entirely the client's job. This object is that decision,
 * expressed purely so any daemon client — the desktop app or a third party embedding control mode
 * in some other host — converges on the same behavior instead of inventing one. The rules are
 * documented for porting in `docs/design-docs/mcp/daemon/screen-control-mapping.md`.
 *
 * Four rules, in the order they are applied:
 * 1. **Modifier-bearing chords stay with the host.** Any keystroke with Ctrl, Alt or Meta held is
 *    [DeviceKeyboardRejection.HostChord] unless its key is on the caller's explicit
 *    `forwardedChordKeys` list. This is stated in terms of *modifiers*, not in terms of one host's
 *    keymap, precisely because the host is not knowable from here: the desktop app has its own menu
 *    accelerators, and a third-party host has different ones again. Refusing every chord by default
 *    is the only rule that is correct for all of them.
 * 2. **A device-meaningful key wins over the character it produced.** Enter, Tab and Backspace all
 *    report a control character; sending those as text would put a literal `\n` in a text field.
 * 3. **A printable ASCII character is typed.** Exactly one character per keystroke — this is not
 *    IME composition, which is explicitly out of scope for #3351. The ASCII restriction is not
 *    arbitrary: the daemon's non-destructive append path types by injecting Android key events, and
 *    its character→keycode table covers exactly `U+0020`–`U+007E`. A character it cannot type must
 *    not be consumed here, or the keystroke is lost twice — never typed on the device, and never
 *    delivered to the host either. Non-ASCII therefore yields
 *    [DeviceKeyboardRejection.CharacterUnsupported] and stays with the host.
 * 4. **Everything else is ignored**, and must be left unconsumed so the host can still use it.
 *
 * One residual gap is deliberately left to the daemon: uppercase letters and shifted symbols need
 * `input keycombination`, which exists only on Android 12 (API 31) and newer. The API level is not
 * visible from here, and refusing every shifted character would make capitals untypable on *every*
 * device in order to protect the older ones. So those are forwarded, and on an older device the
 * daemon answers with an actionable error that the client surfaces in its error banner — a reported
 * failure rather than a silent loss.
 *
 * This object says nothing about **when** a client is allowed to consult it. Focus and mode gating
 * are host concerns — the reference implementation relies on the toolkit's own focus routing, so a
 * keystroke only reaches the policy when the device view holds focus and is in control mode — and
 * are specified in the document above rather than modeled here.
 *
 * Pure: no clock, no Compose, no daemon. [evaluate] is a total function of its arguments.
 */
public object DeviceKeyboardInputPolicy {

  /**
   * Keys that map to a device **button** (`input/pressButton`) rather than to a key event.
   *
   * Only Escape is mapped, and only to `back`. That is not an oversight:
   * - Escape→back is the mapping Android itself applies to a hardware ESC key, and it is supported
   *   on both platforms (unlike `input/key`, which the iOS control proxy does not implement).
   * - Every *other* device button — `home`, `recent`, `power`, `volume_up`, `volume_down`, `menu` —
   *   has no unambiguous keyboard key. Binding `home` to the Home key, for example, would make a
   *   keystroke that means "move to line start" everywhere else silently throw the user out of the
   *   app under test. Buttons with no natural key belong on an explicit on-screen affordance, not
   *   on a guessed binding that steals a host key.
   *
   * A client with a different host may extend the mapping by supplying its own table; this one is
   * the conservative default.
   */
  public val BUTTON_KEYS: Map<DeviceKeyboardKey, String> = mapOf(DeviceKeyboardKey.Escape to "back")

  /**
   * Keys that map to a discrete device key event (`input/key`), using the daemon's own key
   * vocabulary (`src/features/action/InputKey.ts`).
   *
   * `escape` is a valid daemon key name but is deliberately absent here — Escape is claimed by
   * [BUTTON_KEYS] above, and a key cannot be both.
   *
   * `input/key` is Android-only; on iOS the daemon answers with an actionable error, which the
   * client surfaces exactly as it surfaces any other failed input. That is the "report" half of the
   * unsupported-key policy: a key the *client* has no mapping for is silently ignored, while a key
   * the client maps but the *device* cannot accept is reported by the daemon.
   */
  public val DISCRETE_KEYS: Map<DeviceKeyboardKey, String> =
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

  /**
   * Decide what [stroke] should send.
   *
   * @param forwardedChordKeys the explicit escape hatch to rule 1: keys listed here forward even
   *   when a chord modifier is held. Empty by default, because a default that forwarded any chord
   *   would be wrong for some host. A client that knows its host's keymap — and knows a given chord
   *   is unclaimed there — opts that key in deliberately.
   */
  public fun evaluate(
    stroke: DeviceKeyStroke,
    forwardedChords: Set<DeviceChordAllowance> = emptySet(),
    textSupported: Boolean = true,
  ): DeviceKeyboardDecision {
    if (stroke.modifiers.hasChordModifier && !isAllowedChord(stroke, forwardedChords)) {
      return DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.HostChord)
    }
    stroke.key?.let {
      return evaluateKey(it)
    }
    return evaluateCharacter(stroke.character, textSupported)
  }

  /** A key with a device meaning of its own becomes a button press or a discrete key event. */
  private fun evaluateKey(key: DeviceKeyboardKey): DeviceKeyboardDecision {
    BUTTON_KEYS[key]?.let {
      return DeviceKeyboardDecision.PressButton(it)
    }
    DISCRETE_KEYS[key]?.let {
      return DeviceKeyboardDecision.SendKey(it)
    }
    return DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.Unsupported)
  }

  /**
   * Decide what a keystroke that produced only a character should send.
   *
   * The two rejections are deliberately distinct, because they answer different questions. A
   * non-printable character was never a text keystroke at all; a printable non-ASCII one *was*, and
   * is refused only because the daemon's append path cannot type it. Both leave the event
   * unconsumed — the rule is that a keystroke this policy cannot deliver is never swallowed.
   */
  private fun evaluateCharacter(character: Char?, textSupported: Boolean): DeviceKeyboardDecision {
    if (character == null || !isPrintable(character)) {
      return DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.Unsupported)
    }
    if (!isTypable(character)) {
      return DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.CharacterUnsupported)
    }
    // A platform with no non-destructive text primitive must not receive text at all: replacing
    // the field's contents on every keystroke is worse than typing nothing.
    if (!textSupported) {
      return DeviceKeyboardDecision.Ignored(DeviceKeyboardRejection.TextUnsupported)
    }
    return DeviceKeyboardDecision.TypeText(character.toString())
  }

  /**
   * Whether a chord-modified [stroke] is on the caller's explicit forward list, or is AltGr
   * composing a printable character rather than a shortcut.
   */
  private fun isAllowedChord(
    stroke: DeviceKeyStroke,
    forwardedChords: Set<DeviceChordAllowance>,
  ): Boolean {
    val character = stroke.character
    // AltGr-as-Ctrl+Alt, and only when it actually produced something typable. A real Ctrl+Alt
    // accelerator produces no character, so it stays with the host.
    if (stroke.modifiers.isAltGraphShape && character != null && isTypable(character)) return true
    return forwardedChords.any { allowance ->
      when (allowance) {
        is DeviceChordAllowance.OfKey -> stroke.key != null && stroke.key == allowance.key
        is DeviceChordAllowance.OfCharacter ->
          character != null && character.equalsIgnoreCase(allowance.character)
      }
    }
  }

  private fun Char.equalsIgnoreCase(other: Char): Boolean =
    this == other || lowercaseChar() == other.lowercaseChar()

  /**
   * Whether [character] is a character the user actually meant to type, as opposed to a host's way
   * of reporting a non-text key.
   *
   * Excludes ISO control characters (which is how hosts report Enter, Tab, Backspace and friends as
   * characters) and the "no character" sentinel every AWT-derived toolkit uses. Without the first
   * exclusion an unmapped control key would type an invisible control character into whatever field
   * has device focus.
   */
  private fun isPrintable(character: Char): Boolean =
    !character.isISOControl() && character != NO_CHARACTER

  /**
   * Whether [character] is one the daemon's non-destructive append path can actually type.
   *
   * That path injects Android key events from a fixed character\u2192keycode table covering
   * printable ASCII only, so this is the exact set \u2014 no more, because forwarding a character
   * the daemon cannot type would consume the host keystroke for nothing, and no less, because
   * narrowing further would make ordinary punctuation untypable in control mode.
   */
  private fun isTypable(character: Char): Boolean =
    isPrintable(character) && character.code in PRINTABLE_ASCII

  /** `KeyEvent.CHAR_UNDEFINED`: "this keystroke produced no character". */
  private const val NO_CHARACTER: Char = '\uFFFF'

  /**
   * The printable ASCII range, `U+0020` (space) through `U+007E` (`~`).
   *
   * This mirrors `buildAsciiKeyEventPlan` in `src/features/action/asciiKeyEvents.ts`, which has a
   * keycode for every character in this range and for nothing outside it. The two must stay in
   * step; widening one without the other reintroduces the double loss this range exists to prevent.
   */
  private val PRINTABLE_ASCII: IntRange = 0x20..0x7E
}
