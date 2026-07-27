package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.test.fail
import org.junit.Test

/**
 * Coverage for the client-side click-to-tap glue (issue #3347). All tests use fakes — no real
 * device or daemon connection — so they stay fast and non-flaky. The wire serialization of the
 * `input/tap` request is covered separately by `McpDaemonClientInputTest`; here the payload-level
 * assertion runs against [FakeAutoMobileClient]'s recorded call.
 */
class DeviceControlInputForwarderTest {

  private val forwarder = DeviceControlInputForwarder()

  private fun forward(
    point: DevicePoint,
    client: AutoMobileClient?,
    platform: String = "android",
    deviceId: String? = "emulator-5554",
    onError: (String) -> Unit = { error("unexpected error: $it") },
  ) = forwarder.forwardTap(point, client, platform, deviceId, onError)

  @Test
  fun `in-bounds tap forwards mapped device coordinates to inputTap`() {
    val fake = FakeAutoMobileClient()

    forward(
      DevicePoint(x = 540, y = 1100, inBounds = true),
      client = fake,
      platform = "android",
      deviceId = "emulator-5554",
    )

    // Payload-level assertion on the typed helper: coordinates map verbatim (Int device px ->
    // Double)
    // and the active platform/device id are carried through so a third-party client can match it.
    assertEquals(
      listOf(
        FakeAutoMobileClient.InputTapCall(
          x = 540.0,
          y = 1100.0,
          platform = "android",
          deviceId = "emulator-5554",
          duration = null,
        )
      ),
      fake.inputTapCalls,
    )
  }

  @Test
  fun `out-of-bounds tap is dropped and never reaches the daemon`() {
    val fake = FakeAutoMobileClient()
    var error: String? = null

    forward(
      DevicePoint(x = -3, y = 4000, inBounds = false),
      client = fake,
      onError = { error = it },
    )

    assertTrue(fake.inputTapCalls.isEmpty(), "off-screen tap must not be sent")
    assertTrue("inputTap" !in fake.calls)
    assertNull(error, "dropping an off-screen tap is silent, not an error")
  }

  @Test
  fun `no connected client drops the tap without error`() {
    var error: String? = null

    forward(DevicePoint(x = 10, y = 20, inBounds = true), client = null, onError = { error = it })

    assertNull(error)
  }

  @Test
  fun `daemon failure surfaces the actionable error without crashing`() {
    val fake =
      FakeAutoMobileClient().apply {
        inputTapResult =
          InputActionResult(
            action = "input/tap",
            success = false,
            error = "No active android device to tap",
          )
      }
    var error: String? = null

    forward(DevicePoint(x = 100, y = 200, inBounds = true), client = fake, onError = { error = it })

    // The surfaced message is the daemon's own, not an invented generic string.
    assertEquals("No active android device to tap", error)
  }

  @Test
  fun `thrown client exception surfaces its message instead of propagating`() {
    val throwing =
      object : AutoMobileClient by FakeAutoMobileClient() {
        override fun inputTap(
          x: Double,
          y: Double,
          platform: String,
          deviceId: String?,
          duration: Int?,
        ): InputActionResult = throw IllegalStateException("daemon socket closed")
      }
    var error: String? = null

    forward(DevicePoint(x = 5, y = 6, inBounds = true), client = throwing, onError = { error = it })

    assertEquals("daemon socket closed", error)
  }

  @Test
  fun `failure with no message falls back to the default error`() {
    val fake =
      FakeAutoMobileClient().apply {
        inputTapResult = InputActionResult(action = "input/tap", success = false, error = null)
      }
    var error: String? = null

    forward(DevicePoint(x = 1, y = 2, inBounds = true), client = fake, onError = { error = it })

    assertEquals(DeviceControlInputForwarder.DEFAULT_INPUT_ERROR, error)
  }

  @Test
  fun `in-bounds swipe forwards both endpoints and the duration to inputSwipe`() {
    val fake = FakeAutoMobileClient()

    forwarder.forwardSwipe(
      start = DevicePoint(x = 540, y = 1800, inBounds = true),
      end = DevicePoint(x = 540, y = 400, inBounds = true),
      durationMs = 300,
      client = fake,
      platform = "ios",
      deviceId = "sim-udid",
      onError = { error("unexpected error: $it") },
    )

    assertEquals(
      listOf(
        FakeAutoMobileClient.InputSwipeCall(
          startX = 540.0,
          startY = 1800.0,
          endX = 540.0,
          endY = 400.0,
          platform = "ios",
          deviceId = "sim-udid",
          durationMs = 300,
        )
      ),
      fake.inputSwipeCalls,
    )
  }

  @Test
  fun `a swipe with an off-screen endpoint never reaches the daemon`() {
    // The daemon interpolates between the endpoints, so a bad END is as damaging as a bad start.
    val fake = FakeAutoMobileClient()
    var error: String? = null

    forwarder.forwardSwipe(
      start = DevicePoint(x = 540, y = 1800, inBounds = true),
      end = DevicePoint(x = 540, y = 9_000, inBounds = false),
      durationMs = 300,
      client = fake,
      platform = "android",
      deviceId = "emulator-5554",
      onError = { error = it },
    )
    forwarder.forwardSwipe(
      start = DevicePoint(x = -4, y = 10, inBounds = false),
      end = DevicePoint(x = 540, y = 400, inBounds = true),
      durationMs = 300,
      client = fake,
      platform = "android",
      deviceId = "emulator-5554",
      onError = { error = it },
    )

    assertTrue(fake.inputSwipeCalls.isEmpty(), "an off-screen endpoint must not be sent")
    assertTrue("inputSwipe" !in fake.calls)
    assertNull(error, "dropping a malformed swipe is silent, not an error")
  }

  @Test
  fun `a failed swipe surfaces the daemon's actionable error`() {
    val fake =
      FakeAutoMobileClient().apply {
        inputSwipeResult =
          InputActionResult(
            action = "input/swipe",
            success = false,
            error = "No active android device to swipe",
          )
      }
    var error: String? = null

    forwarder.forwardSwipe(
      start = DevicePoint(x = 1, y = 2, inBounds = true),
      end = DevicePoint(x = 3, y = 400, inBounds = true),
      durationMs = 300,
      client = fake,
      platform = "android",
      deviceId = null,
      onError = { error = it },
    )

    assertEquals("No active android device to swipe", error)
  }

  @Test
  fun `a thrown client exception during a swipe surfaces its message`() {
    val throwing =
      object : AutoMobileClient by FakeAutoMobileClient() {
        override fun inputSwipe(
          startX: Double,
          startY: Double,
          endX: Double,
          endY: Double,
          platform: String,
          deviceId: String?,
          durationMs: Int?,
        ): InputActionResult = throw IllegalStateException("daemon socket closed")
      }
    var error: String? = null

    forwarder.forwardSwipe(
      start = DevicePoint(x = 1, y = 2, inBounds = true),
      end = DevicePoint(x = 3, y = 400, inBounds = true),
      durationMs = 300,
      client = throwing,
      platform = "android",
      deviceId = null,
      onError = { error = it },
    )

    assertEquals("daemon socket closed", error)
  }

  @Test
  fun `no connected client drops the swipe without error`() {
    var error: String? = null

    forwarder.forwardSwipe(
      start = DevicePoint(x = 1, y = 2, inBounds = true),
      end = DevicePoint(x = 3, y = 400, inBounds = true),
      durationMs = 300,
      client = null,
      platform = "android",
      deviceId = null,
      onError = { error = it },
    )

    assertNull(error)
  }

  @Test
  fun `empty text never reaches the daemon`() {
    // Nothing is "typed" by an empty string, so sending it would produce a successful input for a
    // device change that never happened — and park the client in the post-input refresh wait.
    val client = FakeAutoMobileClient()

    forwarder.forwardTypeText(
      text = "",
      client = client,
      platform = "android",
      deviceId = "emulator-5554",
      onError = { fail("empty text must not be an error, it must be a no-op: $it") },
    )

    assertEquals(emptyList(), client.inputTypeTextCalls)
  }

  @Test
  fun `no connected client drops button, text and key without error`() {
    var error: String? = null
    val onError: (String) -> Unit = { error = it }

    forwarder.forwardPressButton("back", null, "android", null, onError)
    forwarder.forwardTypeText("a", null, "android", null, onError)
    forwarder.forwardKey("enter", null, "android", null, onError)

    assertNull(error)
  }

  @Test
  fun `a daemon rejection of a key surfaces its actionable error verbatim`() {
    val client = FakeAutoMobileClient()
    client.inputKeyResult =
      InputActionResult(action = "input/key", success = false, error = "unsupported on ios")
    var error: String? = null

    forwarder.forwardKey("enter", client, "ios", "iphone-1", onError = { error = it })

    assertEquals("unsupported on ios", error)
  }
}
