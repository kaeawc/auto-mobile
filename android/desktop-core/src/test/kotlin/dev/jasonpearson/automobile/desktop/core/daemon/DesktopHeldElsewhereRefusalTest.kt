package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Binding refusals from another daemon or a declared binding (#11365, owner decision 2026-11-07),
 * fed from the daemon's captured `test/fixtures/refusal-wire/` answers. The pane shows the device
 * as held elsewhere and the session never re-sends the bind on its own, even when the wire says
 * `retryable: true`; only Take control makes one more attempt.
 */
@OptIn(ExperimentalTestApi::class)
internal class DesktopHeldElsewhereRefusalTest : DesktopDaemonSessionCompositionFixture() {
  @Test
  fun `another daemon's claim is held elsewhere with its PID and bound once over five minutes`() =
    runComposeUiTest {
      val host = refusedFor("device_owned_by_other_daemon")

      assertEquals(HeldElsewhereHolder.AnotherDaemon(pid = 4242), host.state().heldElsewhereHolder)
    }

  @Test
  fun `a device assigned to a binding is held elsewhere with its binding and bound once`() =
    runComposeUiTest {
      val host = refusedFor("device_assigned_to_binding")

      assertEquals(
        HeldElsewhereHolder.Binding(declaredBinding = 0),
        host.state().heldElsewhereHolder,
      )
    }

  @Test
  fun `take control after another daemon releases the device makes exactly one bind`() =
    runComposeUiTest {
      val transport =
        RecordingDaemonTransport().apply {
          bindRefusal = fixture("device_owned_by_other_daemon")
          bindRefusalTimes = 1
        }
      val host = start(transport, listOf(pixel))
      assertFalse(input(host, pixel.deviceId))
      repeat(5) { tick() }
      assertEquals(1, transport.boundDevices().size)

      host.state().requestControl(pixel.deviceId)
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }

      assertEquals(2, transport.boundDevices().size)
      assertEquals("emulator-5554", host.state().boundDeviceId)
      assertEquals(null, host.state().heldElsewhereDeviceId)
      assertEquals(null, host.state().heldElsewhereHolder)
    }

  @Test
  fun `a suspect session is an ordinary bind error whose bounded retry binds`() = runComposeUiTest {
    // The daemon keeps the device reserved while it restores the session and asks for an
    // immediate retry; a terminal outcome comes back as session_ownership_lost, which rotates.
    val transport =
      RecordingDaemonTransport().apply {
        bindRefusal = fixture("daemon_session_suspect")
        bindRefusalTimes = 1
      }
    val host = start(transport, listOf(pixel))
    assertFalse(input(host, pixel.deviceId))
    assertEquals(null, host.state().heldElsewhereDeviceId)

    repeat(2) { tick() }

    assertEquals(2, transport.boundDevices().size)
    assertEquals(1, transport.count("daemon/registerSession"))
    assertEquals("emulator-5554", host.state().boundDeviceId)
    assertEquals(null, host.state().bindErrorMessage)
  }

  /**
   * Starts a session whose every bind answers [code]'s captured refusal, taps once, then runs five
   * virtual minutes. Asserts the shared held-elsewhere outcome: one bind, no bind error, input
   * dropped without another bind.
   */
  private fun ComposeUiTest.refusedFor(code: String): Host {
    val transport = RecordingDaemonTransport().apply { bindRefusal = fixture(code) }
    // A short injected backoff, as the issue's probe used: a cadence retry would show at once.
    val host = start(transport, listOf(pixel), bindRetryBackoff = { 5_000L })

    assertFalse(input(host, pixel.deviceId))
    repeat(FIVE_MINUTES_OF_TICKS) { tick() }
    assertFalse(input(host, pixel.deviceId))

    assertEquals(listOf("emulator-5554"), transport.boundDevices(), code)
    assertEquals("emulator-5554", host.state().heldElsewhereDeviceId, code)
    assertEquals(null, host.state().bindErrorMessage, code)
    assertEquals(null, host.state().boundDeviceId, code)
    assertTrue(host.state().isRegistered, code)
    return host
  }

  private fun fixture(code: String): String = RefusalWireFixtures.case(code).result.toString()

  private companion object {
    /** Five virtual minutes of 2 s heartbeat ticks. */
    const val FIVE_MINUTES_OF_TICKS = 150
  }
}
