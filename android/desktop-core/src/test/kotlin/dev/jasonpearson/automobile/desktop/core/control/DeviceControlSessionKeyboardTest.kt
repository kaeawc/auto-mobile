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
  fun `printable text is not forwarded on a platform that can only replace the field`() = runTest {
    // iOS has no append-capable text helper, so forwarding would wipe the focused field on every
    // keystroke. Disabled beats destructive — and buttons still work, so control mode stays useful.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client, platform = "ios")

    val typed = session.key(testSnapshot(), DeviceKeyStroke(character = 'a'))
    val escaped = session.key(testSnapshot(), escape())
    advanceUntilIdle()

    assertFalse(typed, "a keystroke that cannot be forwarded is left to the host")
    assertTrue(client.inputTypeTextCalls.isEmpty(), "nothing may reach the iOS text helper")
    assertTrue(escaped, "buttons are unaffected by the text restriction")
    assertEquals("back", client.inputPressButtonCalls.single().button)
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
