package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.control.testSnapshot
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyModifiers
import dev.jasonpearson.automobile.desktop.domain.DeviceKeyStroke
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestCoroutineScheduler
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * The frame-identity-free input path for the workspace video pane (issue: "disconnect the video
 * frame from the input").
 *
 * The single property every test pins is that inputs carry **no `frameContext`** — that is what
 * stops the daemon from ever rejecting a video-pane tap as stale, which was the wedge. Everything
 * is injected (client, scope, IO dispatcher) so these run with no device, socket or timer.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class VideoInputDispatcherTest {

  private val inBounds = DevicePoint(x = 360, y = 780, inBounds = true)
  private val outOfBounds = DevicePoint(x = -1, y = -1, inBounds = false)

  private fun CoroutineScope.dispatcher(
    client: FakeAutoMobileClient,
    scheduler: TestCoroutineScheduler,
    platform: String = "android",
    deviceId: String = "emulator-5554",
  ) =
    VideoInputDispatcher(
      scope = this,
      clientProvider = { client },
      platform = { platform },
      deviceId = deviceId,
      tracer = InteractionLatencyTracer(),
      ioDispatcher = UnconfinedTestDispatcher(scheduler),
    )

  @Test
  fun `a tap sends input tap with NO frame context and a fresh client is closed`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val accepted = scope.dispatcher(client, testScheduler).tap(inBounds)
    advanceUntilIdle()

    assertTrue(accepted)
    val call = client.inputTapCalls.single()
    assertEquals(360.0, call.x)
    assertEquals(780.0, call.y)
    assertEquals("emulator-5554", call.deviceId)
    assertEquals("android", call.platform)
    // The decoupling: a video-pane tap carries no observation frame identity, so the daemon can
    // never reject it as "stale frame context" — the pane cannot wedge.
    assertNull(call.frameContext)
    assertTrue("close" in client.calls)
    scope.cancel()
  }

  @Test
  fun `drops input once the dispatch backlog is full`() = runTest {
    // A StandardTestDispatcher queues each launch without running it, so flooding taps piles up the
    // in-flight backlog exactly as a stalled (or mid-reconnect) daemon would. Past the cap the
    // newest taps are shed rather than queued, so a recovery can't replay a burst of stale inputs.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val d =
      VideoInputDispatcher(
        scope = scope,
        clientProvider = { client },
        platform = { "android" },
        deviceId = "emulator-5554",
        tracer = InteractionLatencyTracer(),
        ioDispatcher = StandardTestDispatcher(testScheduler),
      )
    val results = (0 until 100).map { d.tap(DevicePoint(x = it, y = it, inBounds = true)) }
    advanceUntilIdle()

    // MAX_PENDING_DISPATCHES = 64: the first 64 dispatches are accepted, the remaining 36 dropped.
    assertEquals(64, client.inputTapCalls.size)
    // The shed taps report false SYNCHRONOUSLY so the pane withholds their success touch pulse.
    assertTrue(results.take(64).all { it })
    assertTrue(results.drop(64).none { it })
    scope.cancel()
  }

  @Test
  fun `reset drops input queued before it even when reactivated before the queue drains`() =
    runTest {
      // tap(old); reset(); tap(new) with NO drain between reset and the reactivating tap (both taps
      // still queued on the StandardTest dispatcher). A shared quiesced flag would be cleared by
      // tap(new), letting the pre-reset taps replay; a per-dispatch generation drops them
      // regardless
      // (#5221 review). The reactivating tap must still reach the device.
      val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
      val client = FakeAutoMobileClient()
      val d =
        VideoInputDispatcher(
          scope = scope,
          clientProvider = { client },
          platform = { "android" },
          deviceId = "emulator-5554",
          tracer = InteractionLatencyTracer(),
          ioDispatcher = StandardTestDispatcher(testScheduler),
        )
      d.tap(DevicePoint(x = 1, y = 1, inBounds = true))
      d.tap(DevicePoint(x = 2, y = 2, inBounds = true))
      d.reset() // pane deactivated
      d.tap(DevicePoint(x = 3, y = 3, inBounds = true)) // reactivated before the queue drains
      advanceUntilIdle()

      // Only the post-reset tap reaches the device; the two pre-reset taps are dropped.
      assertEquals(listOf(3.0), client.inputTapCalls.map { it.x })
      scope.cancel()
    }

  @Test
  fun `an out-of-bounds tap dispatches nothing and returns false`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val accepted = scope.dispatcher(client, testScheduler).tap(outOfBounds)
    advanceUntilIdle()

    assertFalse(accepted)
    assertTrue(client.inputTapCalls.isEmpty())
    scope.cancel()
  }

  @Test
  fun `rapid taps reach the device in gesture order`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val d = scope.dispatcher(client, testScheduler)
    d.tap(DevicePoint(x = 1, y = 1, inBounds = true))
    d.tap(DevicePoint(x = 2, y = 2, inBounds = true))
    d.tap(DevicePoint(x = 3, y = 3, inBounds = true))
    advanceUntilIdle()

    assertEquals(listOf(1.0, 2.0, 3.0), client.inputTapCalls.map { it.x })
    scope.cancel()
  }

  @Test
  fun `a printable character types text in append mode with no frame context`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val consumed = scope.dispatcher(client, testScheduler).key(DeviceKeyStroke(character = 'a'))
    advanceUntilIdle()

    assertTrue(consumed)
    val call = client.inputTypeTextCalls.single()
    assertEquals("a", call.text)
    assertTrue(call.append)
    assertNull(call.frameContext)
    scope.cancel()
  }

  @Test
  fun `append mode is requested regardless of platform`() = runTest {
    // append=true must NOT be branched on platform: the daemon's default ACTION_SET_TEXT REPLACES
    // the field, so mirroring keystrokes one at a time without append would leave only the last
    // character. The keyboard policy — not this dispatcher — is the gate for a platform lacking
    // append (#3351), so the call always requests it. Mirrors DeviceControlInputForwarder.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    scope.dispatcher(client, testScheduler, platform = "ios").key(DeviceKeyStroke(character = 'a'))
    advanceUntilIdle()

    assertTrue(client.inputTypeTextCalls.single().append)
    scope.cancel()
  }

  @Test
  fun `rapid printable characters coalesce into a single typeText`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val d = scope.dispatcher(client, testScheduler)
    // A fast run of keys within the flush window is one round-trip, not five.
    "hello".forEach { d.key(DeviceKeyStroke(character = it)) }
    advanceUntilIdle()

    val call = client.inputTypeTextCalls.single()
    assertEquals("hello", call.text)
    assertTrue(call.append)
    scope.cancel()
  }

  @Test
  fun `a tap flushes buffered text first, preserving order`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val d = scope.dispatcher(client, testScheduler)
    d.key(DeviceKeyStroke(character = 'a'))
    d.tap(DevicePoint(x = 10, y = 10, inBounds = true))
    advanceUntilIdle()

    // The buffered text is sent (once), and it reaches the device BEFORE the tap.
    assertEquals("a", client.inputTypeTextCalls.single().text)
    assertEquals(1, client.inputTapCalls.size)
    assertTrue(client.calls.indexOf("inputTypeText") < client.calls.indexOf("inputTap"))
    scope.cancel()
  }

  @Test
  fun `a host chord is not forwarded and is left for the host`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val consumed =
      scope
        .dispatcher(client, testScheduler)
        .key(DeviceKeyStroke(character = 'a', modifiers = DeviceKeyModifiers(meta = true)))
    advanceUntilIdle()

    assertFalse(consumed)
    assertTrue(client.calls.none { it.startsWith("input") })
    scope.cancel()
  }

  @Test
  fun `a below-threshold drag sends nothing`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    scope
      .dispatcher(client, testScheduler)
      .swipe(
        testSnapshot(),
        DevicePoint(x = 100, y = 100, inBounds = true),
        DevicePoint(x = 102, y = 101, inBounds = true),
        gestureDurationMs = 120,
      )
    advanceUntilIdle()

    assertTrue(client.inputSwipeCalls.isEmpty())
    scope.cancel()
  }

  @Test
  fun `a real drag swipes with no frame context`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    scope
      .dispatcher(client, testScheduler)
      .swipe(
        testSnapshot(),
        DevicePoint(x = 100, y = 100, inBounds = true),
        DevicePoint(x = 700, y = 1500, inBounds = true),
        gestureDurationMs = 90,
      )
    advanceUntilIdle()

    val call = client.inputSwipeCalls.single()
    assertNull(call.frameContext)
    // The flick's own duration drives the swipe velocity (fling strength), not a fixed value.
    assertEquals(90, call.durationMs)
    scope.cancel()
  }

  @Test
  fun `a device button press carries no frame context`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    scope.dispatcher(client, testScheduler).pressButton("BACK")
    advanceUntilIdle()

    val call = client.inputPressButtonCalls.single()
    assertEquals("BACK", call.button)
    assertNull(call.frameContext)
    scope.cancel()
  }
}
