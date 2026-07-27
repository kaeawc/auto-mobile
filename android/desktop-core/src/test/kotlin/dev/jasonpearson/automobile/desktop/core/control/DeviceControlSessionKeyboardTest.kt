package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyModifiers
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyboardKey
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * Keyboard, text and device-button forwarding through the ONE control seam (issue #3351).
 *
 * Asserts what actually reaches the daemon — the exact typed-helper payload recorded by
 * [FakeAutoMobileClient] — rather than that a callback fired, and that the keyboard path shares the
 * existing queue, error claim and post-input refresh tracker rather than adding its own.
 *
 * Everything is injected, so these run with no real device, socket or timer.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeviceControlSessionKeyboardTest {

  private fun TestScope.session(
    scope: CoroutineScope,
    client: FakeAutoMobileClient,
    publishError: (String?) -> Unit = {},
    platform: String = "android",
  ) =
    DeviceControlSession(
      scope = scope,
      clientProvider = { client },
      platform = { platform },
      nowMs = { 1_000L },
      publishError = publishError,
      uiContext = UnconfinedTestDispatcher(testScheduler),
      ioDispatcher = UnconfinedTestDispatcher(testScheduler),
    )

  @Test
  fun `escape reaches the daemon as a back button press on the snapshot's device`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    val consumed = session.key(testSnapshot(deviceId = "emulator-5554"), escape())
    advanceUntilIdle()

    assertTrue(consumed, "a forwarded keystroke is consumed")
    val call = client.inputPressButtonCalls.single()
    assertEquals("back", call.button)
    assertEquals("android", call.platform)
    // The device id comes from the snapshot the keystroke belongs to, never from a selection
    // resolved at dispatch time.
    assertEquals("emulator-5554", call.deviceId)
    assertTrue(client.inputTypeTextCalls.isEmpty() && client.inputKeyCalls.isEmpty())
    scope.cancel()
  }

  @Test
  fun `a printable character reaches the daemon as typeText`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    session.key(testSnapshot(deviceId = "emulator-5554"), DeviceKeyStroke(character = 'a'))
    advanceUntilIdle()

    val call = client.inputTypeTextCalls.single()
    assertEquals("a", call.text)
    assertEquals("android", call.platform)
    assertEquals("emulator-5554", call.deviceId)
    // Non-negotiable: the daemon's DEFAULT text path is ACTION_SET_TEXT, which REPLACES the
    // focused field. Typing one character at a time through it would leave only the last character
    // and would wipe whatever was already in the field. Append routes through real key events.
    assertTrue(call.append, "per-keystroke text must use the daemon's append mode")
    // `submit` is Enter's job, which travels this seam as its own input/key command. Folding it in
    // here would make one keystroke's effect depend on what was typed before it.
    assertEquals(null, call.submit)
    scope.cancel()
  }

  @Test
  fun `iOS printable keystrokes forward as ordered append requests`() = runTest {
    // The iOS control proxy has an explicit append primitive. The desktop must not hard-code a
    // platform veto here: each character travels through the same ordered queue, with append=true,
    // so a focused field receives a, then b, then c instead of three replace operations.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client, platform = "ios")

    val consumed =
      listOf('a', 'b', 'c').map { character ->
        session.key(testSnapshot(), DeviceKeyStroke(character = character))
      }
    advanceUntilIdle()

    assertTrue(consumed.all { it }, "every forwarded keystroke is consumed")
    assertEquals(listOf("a", "b", "c"), client.inputTypeTextCalls.map { it.text })
    assertTrue(client.inputTypeTextCalls.all { it.platform == "ios" && it.append })
    scope.cancel()
  }

  @Test
  fun `a character the daemon cannot type is left with the host, not swallowed`() = runTest {
    // The double-loss bug: the daemon's append path injects Android key events from an ASCII-only
    // table, so a non-ASCII character can never reach the device. Consuming it anyway would lose
    // the keystroke twice — not typed on the device, and not delivered to the host either.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val published = mutableListOf<String?>()
    val session = session(scope, client, publishError = { published.add(it) })

    val accented = session.key(testSnapshot(), DeviceKeyStroke(character = 'é'))
    val euro = session.key(testSnapshot(), DeviceKeyStroke(character = '€'))
    advanceUntilIdle()

    assertFalse(accented, "an untypable character must reach the host")
    assertFalse(euro, "an untypable character must reach the host")
    assertTrue(
      client.inputCalls().isEmpty(),
      "nothing reaches the daemon (got ${client.inputCalls()})",
    )
    // Nothing was attempted, so nothing failed: no banner, and no refresh wait for a device change
    // that was never requested.
    assertTrue(published.isEmpty(), "a declined keystroke publishes nothing (got $published)")
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `an uppercase letter the device cannot type surfaces the daemon's error`() = runTest {
    // The residual gap the client cannot close: uppercase and shifted symbols need `input
    // keycombination` (API 31+), and the API level is invisible from here. Refusing them outright
    // would make capitals untypable on every device. So they forward, and on an older device the
    // daemon's actionable error must reach the SAME banner as any other failed input — a reported
    // failure, never a silent loss.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    client.inputTypeTextResult =
      InputActionResult(
        action = "input/typeText",
        success = false,
        error = "append cannot type \"A\" with Android key events",
      )
    val published = mutableListOf<String?>()
    val session = session(scope, client, publishError = { published.add(it) })

    val consumed =
      session.key(
        testSnapshot(),
        DeviceKeyStroke(character = 'A', modifiers = DeviceKeyModifiers(shift = true)),
      )
    advanceUntilIdle()

    assertTrue(consumed, "a forwarded keystroke is consumed even when the device rejects it")
    assertEquals("A", client.inputTypeTextCalls.single().text)
    assertEquals(listOf(null, "append cannot type \"A\" with Android key events"), published)
    assertEquals(PostInputRefreshState.Settled, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a shifted device key is left with the host, never sent as the bare key`() = runTest {
    // The daemon's input/key carries no modifiers, so Shift-Tab cannot be transmitted as what the
    // user pressed — and sending bare `tab` would move focus FORWARD when the user asked for
    // backward. The only correct answer is to decline and let the host (which honors Shift-Tab)
    // keep the event.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    val consumed =
      session.key(
        testSnapshot(),
        DeviceKeyStroke(
          key = DeviceKeyboardKey.Tab,
          character = '\t',
          modifiers = DeviceKeyModifiers(shift = true),
        ),
      )
    advanceUntilIdle()

    assertFalse(consumed, "a shifted device key must stay with the host")
    assertTrue(
      client.inputCalls().isEmpty(),
      "nothing reaches the daemon (got ${client.inputCalls()})",
    )
    scope.cancel()
  }

  @Test
  fun `wouldForwardKey mirrors what key() actually dispatches`() = runTest {
    // The shell consults this predicate at PREVIEW time to decide whether to stand its own
    // bindings down; if it ever disagreed with key(), a keystroke could die between the two —
    // consumed by neither shell nor device.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val android = session(scope, FakeAutoMobileClient())
    val ios = session(scope, FakeAutoMobileClient(), platform = "ios")

    // Claimed on Android: printable ASCII text, plain device keys, Escape.
    assertTrue(android.wouldForwardKey(DeviceKeyStroke(character = 'j')))
    assertTrue(android.wouldForwardKey(DeviceKeyStroke(key = DeviceKeyboardKey.Tab)))
    assertTrue(android.wouldForwardKey(DeviceKeyStroke(key = DeviceKeyboardKey.Escape)))
    // Declined everywhere: host chords, shifted device keys, untypable characters.
    assertFalse(
      android.wouldForwardKey(
        DeviceKeyStroke(character = 's', modifiers = DeviceKeyModifiers(meta = true))
      )
    )
    assertFalse(
      android.wouldForwardKey(
        DeviceKeyStroke(key = DeviceKeyboardKey.Tab, modifiers = DeviceKeyModifiers(shift = true))
      )
    )
    assertFalse(android.wouldForwardKey(DeviceKeyStroke(character = 'é')))
    // iOS has the same append contract, so printable text is claimed there too.
    assertTrue(ios.wouldForwardKey(DeviceKeyStroke(character = 'j')))
    assertTrue(ios.wouldForwardKey(DeviceKeyStroke(key = DeviceKeyboardKey.Escape)))
    scope.cancel()
  }

  @Test
  fun `enter reaches the daemon as a discrete key`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    session.key(
      testSnapshot(deviceId = "emulator-5554"),
      DeviceKeyStroke(key = DeviceKeyboardKey.Enter, character = '\n'),
    )
    advanceUntilIdle()

    val call = client.inputKeyCalls.single()
    assertEquals("enter", call.key)
    assertEquals("emulator-5554", call.deviceId)
    // The control character Enter reports must never be typed as text.
    assertTrue(client.inputTypeTextCalls.isEmpty(), "enter must not be typed as text")
    scope.cancel()
  }

  @Test
  fun `a host chord sends nothing and is left for the host`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val published = mutableListOf<String?>()
    val session = session(scope, client, publishError = { published.add(it) })

    val consumed =
      session.key(
        testSnapshot(),
        DeviceKeyStroke(character = 's', modifiers = DeviceKeyModifiers(meta = true)),
      )
    advanceUntilIdle()

    assertFalse(consumed, "an unforwarded chord must not be consumed — the host still needs it")
    assertTrue(
      client.inputCalls().isEmpty(),
      "nothing reaches the daemon (got ${client.inputCalls()})",
    )
    // An ignored keystroke is not a failed input: no banner is touched, and the client must not
    // park in AwaitingSnapshot for a device change that was never requested.
    assertTrue(published.isEmpty(), "an ignored keystroke publishes nothing (got $published)")
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a tap-then-type sequence executes in the order the user made it`() = runTest {
    // The ordering guarantee that the ONE shared queue exists for. A separate keyboard queue would
    // let the two race and reach the device reversed.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val snapshot = testSnapshot()

    session.tap(snapshot, DevicePoint(x = 360, y = 780, inBounds = true))
    session.key(snapshot, DeviceKeyStroke(character = 'a'))
    session.key(snapshot, escape())
    advanceUntilIdle()

    assertEquals(listOf("inputTap", "inputTypeText", "inputPressButton"), client.inputCalls())
    scope.cancel()
  }

  @Test
  fun `a successful keystroke awaits the first superseding snapshot`() = runTest {
    // The #3348 post-input refresh policy, reused unchanged: a keystroke changed the device, so the
    // client waits for the observation stream rather than polling.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val session = session(scope, FakeAutoMobileClient())

    session.key(testSnapshot(sequence = 5L), DeviceKeyStroke(character = 'a'))
    advanceUntilIdle()

    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a daemon rejection surfaces verbatim and settles without waiting`() = runTest {
    // input/key is Android-only; on iOS the daemon answers with an actionable error. That is the
    // "reported" half of the unsupported-key policy, and it must reach the same banner every other
    // failed input uses.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    client.inputKeyResult =
      InputActionResult(
        action = "input/key",
        success = false,
        error = "input/key is unsupported on ios; CtrlProxy does not expose discrete key events",
      )
    val published = mutableListOf<String?>()
    val session = session(scope, client, publishError = { published.add(it) })

    session.key(testSnapshot(), DeviceKeyStroke(key = DeviceKeyboardKey.Enter))
    advanceUntilIdle()

    assertEquals(
      listOf(
        null,
        "input/key is unsupported on ios; CtrlProxy does not expose discrete key events",
      ),
      published,
    )
    assertEquals(PostInputRefreshState.Settled, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `reset drops a queued keystroke so it cannot fire in the new control context`() = runTest {
    // Keyboard input is subject to the SAME reset as taps and swipes — one queue, one reset. A
    // StandardTestDispatcher scope leaves the consumer unstarted, so the command is still queued.
    val scope = CoroutineScope(kotlinx.coroutines.test.StandardTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    session.key(testSnapshot(), DeviceKeyStroke(character = 'a'))
    session.reset()
    advanceUntilIdle()

    assertTrue(
      client.inputCalls().isEmpty(),
      "a keystroke queued before reset must not fire after it (got ${client.inputCalls()})",
    )
    scope.cancel()
  }

  private fun escape() = DeviceKeyStroke(key = DeviceKeyboardKey.Escape)

  /**
   * The daemon input requests the fake recorded, in order. `calls` also records the `close` every
   * dispatched command makes, which says nothing about what reached the device.
   */
  private fun FakeAutoMobileClient.inputCalls(): List<String> = calls.filter {
    it.startsWith("input")
  }
}
