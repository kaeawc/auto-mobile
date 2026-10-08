package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.Dispatchers

/**
 * #10237: the session loop heartbeats every [HEARTBEAT_MS] but must send `setActiveDevice` only
 * when the binding changes or was lost. Virtual time (`mainClock`) over the in-memory transport.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopDaemonSessionCompositionTest {
  private val pixel = DesktopDaemonSessionBinding("emulator-5554", "android")
  private val pixelFold = DesktopDaemonSessionBinding("emulator-5556", "android")

  @Test
  fun `unchanged focus binds once across many heartbeat ticks`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()

    repeat(5) { tick() }

    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    assertEquals(5, transport.count("daemon/heartbeat"))
  }

  @Test
  fun `a focus change binds the new device once`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }

    binding.value = pixelFold
    mainClock.advanceTimeByFrame()
    repeat(3) { tick() }

    assertEquals(listOf("emulator-5554", "emulator-5556"), transport.boundDevices())
  }

  @Test
  fun `a lapsed heartbeat re-registers by re-sending the binding exactly once`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      setContent { sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals(1, transport.boundDevices().size)

      // Daemon restart: the next heartbeat is refused, which loses the binding.
      transport.failNext("daemon/heartbeat")
      tick()
      assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())

      repeat(3) { tick() }
      assertEquals(2, transport.boundDevices().size)
    }

  @Test
  fun `a failed bind is retried on the next tick and then stops once acknowledged`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      transport.failNext("tools/call:setActiveDevice")
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      setContent { sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      assertEquals(1, transport.boundDevices().size)

      tick()
      assertEquals(2, transport.boundDevices().size)
      repeat(3) { tick() }
      assertEquals(2, transport.boundDevices().size)
    }

  @Test
  fun `a rejected bind result is not retried on later ticks`() = runComposeUiTest {
    val transport = RecordingDaemonTransport(rejectBindsUntilAttempt = 2)
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()

    repeat(4) { tick() }

    assertEquals(1, transport.boundDevices().size)
  }

  @Test
  fun `a bind refused because another session holds the device never re-sends it`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      var state: DesktopDaemonSessionState? = null
      setContent { state = sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()

      repeat(10) { tick() }

      assertEquals(listOf("emulator-5554"), transport.boundDevices())
      // Viewing keeps the session alive as an observer instead of allocating the device.
      assertEquals(1, transport.count("daemon/registerSession"))
      assertEquals(10, transport.count("daemon/heartbeat"))
      assertEquals("emulator-5554", state?.viewingDeviceId)
      assertEquals(null, state?.boundDeviceId)
    }

  @Test
  fun `the holder releasing the device does not grab it`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    var state: DesktopDaemonSessionState? = null
    setContent { state = sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }

    transport.heldByAnotherSession = false
    repeat(10) { tick() }

    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    assertEquals("emulator-5554", state?.viewingDeviceId)
  }

  @Test
  fun `a heartbeat lapse while viewing re-registers without binding`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    tick()
    transport.heldByAnotherSession = false

    transport.failNext("daemon/heartbeat")
    repeat(3) { tick() }

    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    assertEquals(2, transport.count("daemon/registerSession"))
  }

  @Test
  fun `take control makes exactly one bind attempt`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    var state: DesktopDaemonSessionState? = null
    setContent { state = sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }
    transport.heldByAnotherSession = false

    state.takeControl()
    mainClock.advanceTimeByFrame()
    repeat(5) { tick() }

    assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
    assertEquals(null, state?.viewingDeviceId)
    assertEquals("emulator-5554", state?.boundDeviceId)
  }

  @Test
  fun `take control refused again stays viewing after one attempt`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    var state: DesktopDaemonSessionState? = null
    setContent { state = sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    tick()

    state.takeControl()
    mainClock.advanceTimeByFrame()
    repeat(5) { tick() }

    assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
    assertEquals("emulator-5554", state?.viewingDeviceId)
  }

  @Test
  fun `a null binding never binds a device across ticks and a later pick binds once`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(null)
      setContent { sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()

      repeat(5) { tick() }
      assertEquals(emptyList(), transport.boundDevices())

      binding.value = pixel
      mainClock.advanceTimeByFrame()
      repeat(3) { tick() }
      assertEquals(listOf("emulator-5554"), transport.boundDevices())
    }

  private fun DesktopDaemonSessionState?.takeControl() = requireNotNull(this).requestControl()

  @Test
  fun `closing the last pane releases the held device and stops its heartbeat`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      setContent { sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals(0, transport.count("daemon/releaseSession"))

      binding.value = null
      mainClock.advanceTimeByFrame()
      mainClock.advanceTimeByFrame()
      val heartbeatsAtClose = transport.sessionsFor("daemon/heartbeat").count { it == "session-1" }
      repeat(3) { tick() }

      assertEquals(listOf<String?>("session-1"), transport.sessionsFor("daemon/releaseSession"))
      assertEquals(
        heartbeatsAtClose,
        transport.sessionsFor("daemon/heartbeat").count { it == "session-1" },
      )
    }

  @Test
  fun `a focus change between devices keeps the session and never releases`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }

    // Closing one of two panes moves focus to the survivor; the session stays held.
    binding.value = pixelFold
    mainClock.advanceTimeByFrame()
    repeat(3) { tick() }

    assertEquals(0, transport.count("daemon/releaseSession"))
    assertEquals(setOf<String?>("session-1"), transport.sessionsFor("daemon/heartbeat").toSet())
  }

  @Test
  fun `refocusing after the last pane closed re-acquires under a fresh session`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      setContent { sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      binding.value = null
      mainClock.advanceTimeByFrame()
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals(listOf("emulator-5554"), transport.boundDevices())

      binding.value = pixel
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }

      assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
      assertEquals(1, transport.count("daemon/releaseSession"))
    }

  @Test
  fun `a refused bind is not a device hold so unfocusing releases nothing`() = runComposeUiTest {
    val transport = RecordingDaemonTransport(rejectBindsUntilAttempt = 99)
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }

    binding.value = null
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }

    assertEquals(0, transport.count("daemon/releaseSession"))
  }

  private var sessionCounter = 0

  private fun ComposeUiTest.tick() {
    mainClock.advanceTimeBy(HEARTBEAT_MS)
    mainClock.advanceTimeByFrame()
  }

  @Composable
  private fun sessionHost(
    transport: RecordingDaemonTransport,
    binding: MutableState<DesktopDaemonSessionBinding?>,
  ): DesktopDaemonSessionState {
    return rememberDesktopDaemonSession(
      socketPath = "in-memory",
      binding = binding,
      sessionFactory = {
        DesktopDaemonSession(
          McpDaemonClient(transport, sessionUuid = "session-${++sessionCounter}")
        )
      },
      ioDispatcher = Dispatchers.Unconfined,
      cleanupDispatcher = Dispatchers.Unconfined,
    )
  }

  private companion object {
    const val HEARTBEAT_MS = 2_000L
  }
}
