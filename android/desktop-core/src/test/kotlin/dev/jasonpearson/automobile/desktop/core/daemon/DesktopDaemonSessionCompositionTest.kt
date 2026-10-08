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
  fun `a rejected bind result is retried and stops once acknowledged`() = runComposeUiTest {
    val transport = RecordingDaemonTransport(rejectBindsUntilAttempt = 2)
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    var state: DesktopDaemonSessionState? = null
    setContent { state = sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()

    repeat(4) { tick() }

    assertEquals(2, transport.boundDevices().size)
    assertEquals("emulator-5554", state?.boundDeviceId)
  }

  @Test
  fun `an unrelated bind error never enters viewing and recovers on a bounded retry`() =
    runComposeUiTest {
      // #10682: device cleanup still running / CtrlProxy resuming is not "held by another session".
      val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 1 }
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      var state: DesktopDaemonSessionState? = null
      setContent { state = sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      assertEquals(null, state?.viewingDeviceId)

      repeat(4) { tick() }

      assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
      assertEquals(null, state?.viewingDeviceId)
      assertEquals(null, state?.bindErrorMessage)
      assertEquals("emulator-5554", state?.boundDeviceId)
    }

  @Test
  fun `a persistent unrelated bind error is surfaced after bounded retries, not as viewing`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 99 }
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      var state: DesktopDaemonSessionState? = null
      setContent { state = sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()

      repeat(10) { tick() }

      assertEquals(MAX_BIND_ATTEMPTS, transport.boundDevices().size)
      assertEquals(null, state?.viewingDeviceId)
      assertEquals(null, state?.boundDeviceId)
      assertEquals("Device 'emulator-5554' not found in device pool", state?.bindErrorMessage)
      // Still registered and heartbeating without the device.
      assertEquals(true, state?.isRegistered)

      // Retry is one more bounded round.
      transport.unrelatedBindFailures = 0
      state.takeControl()
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals("emulator-5554", state?.boundDeviceId)
      assertEquals(null, state?.bindErrorMessage)
    }

  @Test
  fun `a surfaced bind error is retried automatically on a slow cadence and clears on success`() =
    runComposeUiTest {
      // #10716: no heartbeat lapse and no Retry click.
      val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 99 }
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      var state: DesktopDaemonSessionState? = null
      setContent { state = sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()

      repeat(10) { tick() }
      assertEquals(MAX_BIND_ATTEMPTS, transport.boundDevices().size)

      // Well inside the cadence: no further attempt.
      repeat(5) { tick() }
      assertEquals(MAX_BIND_ATTEMPTS, transport.boundDevices().size)

      // Past the cadence: exactly one more attempt, which fails and keeps the error surfaced.
      repeat(BIND_ERROR_RETRY_INTERVAL_MS.toInt() / HEARTBEAT_MS.toInt()) { tick() }
      assertEquals(MAX_BIND_ATTEMPTS + 1, transport.boundDevices().size)
      assertEquals("Device 'emulator-5554' not found in device pool", state?.bindErrorMessage)

      // The device comes back: the next cadence attempt binds and clears the error.
      transport.unrelatedBindFailures = 0
      repeat(BIND_ERROR_RETRY_INTERVAL_MS.toInt() / HEARTBEAT_MS.toInt() + 2) { tick() }
      assertEquals("emulator-5554", state?.boundDeviceId)
      assertEquals(null, state?.bindErrorMessage)
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
  fun `picking a device held elsewhere releases the device this session holds`() =
    runComposeUiTest {
      // #10682 C3: the daemon refuses the new pick before rebinding, so the session would keep
      // holding the old device (and heartbeating it) while the pane only views the new one.
      val transport = RecordingDaemonTransport().apply { heldDeviceIds += pixelFold.deviceId }
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      var state: DesktopDaemonSessionState? = null
      setContent { state = sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals("emulator-5554", state?.boundDeviceId)

      binding.value = pixelFold
      mainClock.advanceTimeByFrame()
      mainClock.advanceTimeByFrame()
      mainClock.advanceTimeByFrame()
      val oldSessionHeartbeats =
        transport.sessionsFor("daemon/heartbeat").count { it == "session-1" }
      repeat(3) { tick() }

      assertEquals(listOf<String?>("session-1"), transport.sessionsFor("daemon/releaseSession"))
      assertEquals(
        oldSessionHeartbeats,
        transport.sessionsFor("daemon/heartbeat").count { it == "session-1" },
      )
      assertEquals(3, transport.sessionsFor("daemon/heartbeat").count { it == "session-2" })
      assertEquals("emulator-5556", state?.viewingDeviceId)
      assertEquals(null, state?.boundDeviceId)
      // The fresh session holds nothing, so closing the pane releases nothing more.
      binding.value = null
      mainClock.advanceTimeByFrame()
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals(1, transport.count("daemon/releaseSession"))
    }

  /** Binds [pixel] under session-1, then has the daemon idle-release session-1 (C4). */
  private fun ComposeUiTest.idleReleaseBoundSession(
    transport: RecordingDaemonTransport
  ): () -> DesktopDaemonSessionState {
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    var state: DesktopDaemonSessionState? = null
    setContent { state = sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }
    assertEquals("emulator-5554", state?.boundDeviceId)

    transport.releasedSessions += "session-1"
    tick()
    mainClock.advanceTimeByFrame()
    mainClock.advanceTimeByFrame()
    return { requireNotNull(state) }
  }

  @Test
  fun `an idle-released session views under a fresh uuid and never re-binds on its own`() =
    runComposeUiTest {
      // #10682 C4 + owner decision 2026-10-08: the daemon released the device for inactivity.
      // Re-binding automatically would defeat that release (and repeat every 2 min).
      val transport = RecordingDaemonTransport()
      val state = idleReleaseBoundSession(transport)
      repeat(5) { tick() }

      // session-1's automatic re-send is refused as terminal exactly once; session-2 never binds.
      assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
      assertEquals("emulator-5554", state().idleReleasedDeviceId)
      assertEquals(null, state().boundDeviceId)
      assertEquals(null, state().viewingDeviceId)
      assertEquals(null, state().bindErrorMessage)
      // Still registered and heartbeating as a fresh, unbound viewer.
      assertEquals(true, state().isRegistered)
      assertEquals(5, transport.sessionsFor("daemon/heartbeat").count { it == "session-2" })
      assertEquals("session-2", state().sessionUuidProvider())
    }

  @Test
  fun `input on the idle-released device re-binds it exactly once`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val state = idleReleaseBoundSession(transport)
    tick()

    state().onUserInteraction("emulator-5556")
    mainClock.advanceTimeByFrame()
    tick()
    assertEquals(2, transport.boundDevices().size)

    repeat(3) { state().onUserInteraction("emulator-5554") }
    mainClock.advanceTimeByFrame()
    repeat(3) { tick() }

    assertEquals(3, transport.boundDevices().size)
    assertEquals("emulator-5554", state().boundDeviceId)
    assertEquals(null, state().idleReleasedDeviceId)
    assertEquals(0, transport.sessionsFor("daemon/heartbeat").count { it == "session-3" })
  }

  @Test
  fun `take control on the idle-released device re-binds it`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val state = idleReleaseBoundSession(transport)
    tick()

    state().requestControl()
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }

    assertEquals(3, transport.boundDevices().size)
    assertEquals("emulator-5554", state().boundDeviceId)
    assertEquals(null, state().idleReleasedDeviceId)
  }

  @Test
  fun `a daemon restart lapse re-binds on its own because the session was not released`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      var state: DesktopDaemonSessionState? = null
      setContent { state = sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      tick()

      transport.failNext("daemon/heartbeat")
      repeat(3) { tick() }

      assertEquals(2, transport.boundDevices().size)
      assertEquals("emulator-5554", state?.boundDeviceId)
      assertEquals(null, state?.idleReleasedDeviceId)
    }

  @Test
  fun `take control with a released session uuid binds under a fresh session`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    var state: DesktopDaemonSessionState? = null
    setContent { state = sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }
    transport.heldByAnotherSession = false
    transport.releasedSessions += "session-1"

    state.takeControl()
    mainClock.advanceTimeByFrame()
    mainClock.advanceTimeByFrame()
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }

    assertEquals(null, state?.viewingDeviceId)
    assertEquals(null, state?.bindErrorMessage)
    assertEquals("emulator-5554", state?.boundDeviceId)
    assertEquals(3, transport.boundDevices().size)
  }

  @Test
  fun `a failed bind to another device releases the device this session holds`() =
    runComposeUiTest {
      // Finding 1: the daemon throws before rebinding, so session-1 would keep holding pixel
      // (invisible to every other session) behind a pane that cannot use the new pick.
      val transport = RecordingDaemonTransport()
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      var state: DesktopDaemonSessionState? = null
      setContent { state = sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals("emulator-5554", state?.boundDeviceId)

      transport.unrelatedBindFailures = 99
      binding.value = pixelFold
      mainClock.advanceTimeByFrame()
      repeat(MAX_BIND_ATTEMPTS) { tick() }
      mainClock.advanceTimeByFrame()
      mainClock.advanceTimeByFrame()
      val freshHeartbeats = transport.sessionsFor("daemon/heartbeat").count { it == "session-2" }
      repeat(3) { tick() }

      assertEquals(listOf<String?>("session-1"), transport.sessionsFor("daemon/releaseSession"))
      // The fresh session shows the error without re-running the bounded retries.
      assertEquals(1 + MAX_BIND_ATTEMPTS, transport.boundDevices().size)
      assertEquals("Device 'emulator-5554' not found in device pool", state?.bindErrorMessage)
      assertEquals(null, state?.boundDeviceId)
      assertEquals(true, state?.isRegistered)
      assertEquals(
        freshHeartbeats + 3,
        transport.sessionsFor("daemon/heartbeat").count { it == "session-2" },
      )
      // session-2 holds nothing, so closing the pane releases nothing more.
      binding.value = null
      mainClock.advanceTimeByFrame()
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals(1, transport.count("daemon/releaseSession"))
    }

  @Test
  fun `a failed bind without a held device stays on the same session`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 99 }
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    setContent { sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    repeat(6) { tick() }

    assertEquals(0, transport.count("daemon/releaseSession"))
    assertEquals(setOf<String?>("session-1"), transport.sessionsFor("daemon/heartbeat").toSet())
  }

  @Test
  fun `the session stays registered while a failing bind is retried`() = runComposeUiTest {
    // Finding 3: streams authenticate with the session UUID during the bounded retries too.
    val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 99 }
    val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
    var state: DesktopDaemonSessionState? = null
    setContent { state = sessionHost(transport, binding) }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()

    assertEquals(1, transport.boundDevices().size)
    assertEquals(true, state?.isRegistered)
    assertEquals("session-1", state?.sessionUuidProvider?.invoke())
    assertEquals(null, state?.bindErrorMessage)
    tick()
    assertEquals(2, transport.boundDevices().size)
    assertEquals("session-1", state?.sessionUuidProvider?.invoke())
  }

  @Test
  fun `a surfaced bind error clears itself once a re-bind after a lapse succeeds`() =
    runComposeUiTest {
      // Finding 4: the device comes back after a daemon restart; no Retry click needed.
      val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 99 }
      val binding = mutableStateOf<DesktopDaemonSessionBinding?>(pixel)
      var state: DesktopDaemonSessionState? = null
      setContent { state = sessionHost(transport, binding) }
      mainClock.autoAdvance = false
      mainClock.advanceTimeByFrame()
      repeat(4) { tick() }
      assertEquals("Device 'emulator-5554' not found in device pool", state?.bindErrorMessage)

      transport.unrelatedBindFailures = 0
      transport.failNext("daemon/heartbeat")
      repeat(2) { tick() }

      assertEquals("emulator-5554", state?.boundDeviceId)
      assertEquals(null, state?.bindErrorMessage)
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
