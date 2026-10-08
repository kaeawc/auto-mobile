package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers

/**
 * H4 reproduction, desktop side: clearing the focused binding (closing the focused column, going
 * back to the home grid) does NOT unbind the desktop's per-run session UUID from the device it was
 * last focused on. The Compose effect restarts with `target == null`, calls
 * `ensureRegistered()` — a no-op once `deviceBound()` set `ready = true`
 * (DesktopSessionRegistration.kt:15-24) — and keeps sending the tokenless `daemon/heartbeat
 * {sessionId}` every 2 s (DesktopDaemonSessionComposition.kt:123-176, McpDaemonClient.kt:855-863).
 * Nothing releases or re-registers the session until the composition is disposed
 * (DesktopDaemonSessionComposition.kt:91-105), while the returned state reports
 * `boundDeviceId = null`.
 *
 * The daemon half (test/daemon/desktopUnfocusedSessionHoldsDevice.test.ts) shows that this exact
 * frame sequence keeps the pool device busy under the desktop UUID indefinitely.
 *
 * Virtual time (`mainClock`) over the in-memory [RecordingDaemonTransport]; production code driven:
 * [rememberDesktopDaemonSession], [DesktopDaemonSession], [DesktopSessionRegistration],
 * [McpDaemonClient] request framing.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopDaemonSessionUnfocusHoldTest {
  private val pixel = DesktopDaemonSessionBinding("emulator-5554", "android")

  @Test
  fun `clearing the focused binding keeps heartbeating the bound session and never unbinds it`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      var state: DesktopDaemonSessionState? = null
      setContent { state = sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals(listOf("emulator-5554"), transport.boundDevices())
      assertEquals("emulator-5554", state?.boundDeviceId)
      val heartbeatsWhileFocused = transport.count("daemon/heartbeat")

      // The user closes the focused column / returns to the home grid and leaves the app open.
      binding.value = null
      mainClock.advanceTimeByFrame()
      repeat(30) { tick() } // one virtual minute

      // CURRENT behaviour (H4): the heartbeat keeps flowing for the device-bound UUID, no
      // release/unbind/re-registration frame is ever sent, and the UI reports no binding.
      assertTrue(
        transport.count("daemon/heartbeat") - heartbeatsWhileFocused >= 29,
        "heartbeats after unfocus: ${transport.count("daemon/heartbeat") - heartbeatsWhileFocused}",
      )
      assertEquals(0, transport.count("daemon/releaseSession"))
      assertEquals(0, transport.count("daemon/registerSession"))
      assertEquals(listOf("emulator-5554"), transport.boundDevices())
      assertNull(state?.boundDeviceId)

      // AFTER A FIX the null target must give the device back: expect exactly one
      // `daemon/releaseSession` (or an explicit unbind / re-registration as a deviceless
      // observer under a fresh UUID) right after `binding.value = null`, and any later
      // `daemon/heartbeat` must not refresh a device-bound session.
    }

  private fun ComposeUiTest.tick() {
    mainClock.advanceTimeBy(HEARTBEAT_MS)
    mainClock.advanceTimeByFrame()
  }

  @Composable
  private fun sessionHost(
    transport: RecordingDaemonTransport,
    binding: MutableState<DesktopDaemonSessionBinding?>,
  ): DesktopDaemonSessionState =
    rememberDesktopDaemonSession(
      socketPath = "in-memory",
      binding = binding,
      sessionFactory = {
        DesktopDaemonSession(McpDaemonClient(transport, sessionUuid = "desktop-session"))
      },
      ioDispatcher = Dispatchers.Unconfined,
    )

  private companion object {
    const val HEARTBEAT_MS = 2_000L
  }
}
