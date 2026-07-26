package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Coverage for the client-side click-to-tap glue (issue #3347). All tests use fakes — no real
 * device or daemon connection — so they stay fast and non-flaky. The wire serialization of the
 * `input/tap` request is covered separately by `McpDaemonClientInputTest`; here the payload-level
 * assertion runs against [FakeAutoMobileClient]'s recorded call.
 */
class DeviceControlTapForwarderTest {

  private val forwarder = DeviceControlTapForwarder()

  private fun forward(
    point: DevicePoint,
    client: AutoMobileClient?,
    platform: String = "android",
    deviceId: String? = "emulator-5554",
    onError: (String) -> Unit = { error("unexpected error: $it") },
  ) = forwarder.forward(point, client, platform, deviceId, onError)

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

    assertEquals(DeviceControlTapForwarder.DEFAULT_TAP_ERROR, error)
  }
}
