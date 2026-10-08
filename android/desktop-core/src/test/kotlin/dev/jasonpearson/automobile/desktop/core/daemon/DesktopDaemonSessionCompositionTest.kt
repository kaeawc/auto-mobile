package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

/**
 * The desktop session's allocation loop (#10237, #10730). Watching a pane allocates nothing; the
 * first input on a device sends `setActiveDevice` once, and the loop then only heartbeats. When the
 * daemon drops the hold the session watches under a fresh UUID and never re-binds on its own.
 * Virtual time (`mainClock`) over the in-memory transport.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopDaemonSessionCompositionTest {
  private val pixel = DesktopDaemonSessionBinding("emulator-5554", "android")
  private val pixelFold = DesktopDaemonSessionBinding("emulator-5556", "android")

  @Test
  fun `watching a pane never binds across many heartbeat ticks`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val host = start(transport, listOf(pixel))

    repeat(5) { tick() }

    assertEquals(emptyList(), transport.boundDevices())
    assertEquals(1, transport.count("daemon/registerSession"))
    assertEquals(5, transport.count("daemon/heartbeat"))
    assertEquals(null, host.state().boundDeviceId)
    assertEquals(true, host.state().isRegistered)
  }

  @Test
  fun `the first input binds once and later inputs bind nothing more`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val host = start(transport, listOf(pixel))
    tick()

    assertTrue(input(host, pixel.deviceId))
    repeat(3) {
      tick()
      assertTrue(input(host, pixel.deviceId))
    }
    repeat(2) { tick() }

    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    assertEquals("emulator-5554", host.state().boundDeviceId)
  }

  @Test
  fun `input on another visible pane moves the allocation without a release`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val host = start(transport, listOf(pixel, pixelFold))
    assertTrue(input(host, pixel.deviceId))
    repeat(2) { tick() }

    assertTrue(input(host, pixelFold.deviceId))
    repeat(3) { tick() }

    assertEquals(listOf("emulator-5554", "emulator-5556"), transport.boundDevices())
    assertEquals(0, transport.count("daemon/releaseSession"))
    assertEquals(setOf<String?>("session-1"), transport.sessionsFor("daemon/heartbeat").toSet())
    assertEquals("emulator-5556", host.state().boundDeviceId)
  }

  @Test
  fun `a held device stays held while its pane is visible but unfocused`() = runComposeUiTest {
    // Focus is not an input (#10730): a second pane opening or being focused changes nothing.
    val transport = RecordingDaemonTransport()
    val host = start(transport, listOf(pixel))
    assertTrue(input(host, pixel.deviceId))
    tick()

    host.panes.value = listOf(pixel, pixelFold)
    settle()
    repeat(3) { tick() }

    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    assertEquals(0, transport.count("daemon/releaseSession"))
    assertEquals("emulator-5554", host.state().boundDeviceId)
  }

  @Test
  fun `a lapse after a bind drops back to watching under a fresh session and never re-binds`() =
    runComposeUiTest {
      // Idle release, daemon restart or expiry: re-sending the bind would undo the release.
      val transport = RecordingDaemonTransport()
      val host = start(transport, listOf(pixel))
      assertTrue(input(host, pixel.deviceId))
      repeat(2) { tick() }

      transport.failNext("daemon/heartbeat")
      tick()
      settle()
      repeat(40) { tick() }

      assertEquals(listOf("emulator-5554"), transport.boundDevices())
      assertEquals(listOf<String?>("session-1"), transport.sessionsFor("daemon/releaseSession"))
      assertEquals(40, transport.sessionsFor("daemon/heartbeat").count { it == "session-2" })
      assertEquals(null, host.state().boundDeviceId)
      assertEquals("emulator-5554", host.state().idleReleasedDeviceId)
      assertEquals("session-2", host.state().sessionUuidProvider())
      assertEquals(true, host.state().isRegistered)

      // The next input allocates it again, once, under the fresh session.
      assertTrue(input(host, pixel.deviceId))
      repeat(2) { tick() }
      assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
      assertEquals("emulator-5554", host.state().boundDeviceId)
      assertEquals(null, host.state().idleReleasedDeviceId)
    }

  @Test
  fun `an idle-released session drops back to watching`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val host = start(transport, listOf(pixel))
    assertTrue(input(host, pixel.deviceId))
    tick()

    transport.releasedSessions += "session-1"
    tick()
    settle()
    repeat(5) { tick() }

    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    assertEquals("emulator-5554", host.state().idleReleasedDeviceId)
    assertEquals(5, transport.sessionsFor("daemon/heartbeat").count { it == "session-2" })
  }

  @Test
  fun `a lapse while only watching re-registers the same session without binding`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      start(transport, listOf(pixel))
      tick()

      transport.failNext("daemon/heartbeat")
      repeat(3) { tick() }

      assertEquals(emptyList(), transport.boundDevices())
      assertEquals(2, transport.count("daemon/registerSession"))
      assertEquals(setOf<String?>("session-1"), transport.sessionsFor("daemon/heartbeat").toSet())
    }

  @Test
  fun `a transport failure drops the input and the bind is retried until acknowledged`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val host = start(transport, listOf(pixel))
      transport.failNext("tools/call:setActiveDevice")

      assertFalse(input(host, pixel.deviceId))
      assertEquals(1, transport.boundDevices().size)
      tick()
      assertEquals(2, transport.boundDevices().size)
      repeat(3) { tick() }
      assertEquals(2, transport.boundDevices().size)
      assertTrue(input(host, pixel.deviceId))
    }

  @Test
  fun `a rejected bind result is retried and stops once acknowledged`() = runComposeUiTest {
    val transport = RecordingDaemonTransport(rejectBindsUntilAttempt = 2)
    val host = start(transport, listOf(pixel))
    assertFalse(input(host, pixel.deviceId))

    repeat(4) { tick() }

    assertEquals(2, transport.boundDevices().size)
    assertEquals("emulator-5554", host.state().boundDeviceId)
  }

  @Test
  fun `an unrelated bind error is never held elsewhere and recovers on a bounded retry`() =
    runComposeUiTest {
      // #10682: device cleanup still running / CtrlProxy resuming is not "held by another session".
      val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 1 }
      val host = start(transport, listOf(pixel))
      assertFalse(input(host, pixel.deviceId))
      assertEquals(null, host.state().heldElsewhereDeviceId)

      repeat(4) { tick() }

      assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
      assertEquals(null, host.state().heldElsewhereDeviceId)
      assertEquals(null, host.state().bindErrorMessage)
      assertEquals("emulator-5554", host.state().boundDeviceId)
    }

  @Test
  fun `a persistent unrelated bind error is surfaced after bounded retries, not as held elsewhere`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 99 }
      val host = start(transport, listOf(pixel))
      assertFalse(input(host, pixel.deviceId))

      repeat(10) { tick() }

      assertEquals(MAX_BIND_ATTEMPTS, transport.boundDevices().size)
      assertEquals(null, host.state().heldElsewhereDeviceId)
      assertEquals(null, host.state().boundDeviceId)
      assertEquals("Device 'emulator-5554' not found in device pool", host.state().bindErrorMessage)
      assertEquals("emulator-5554", host.state().bindErrorDeviceId)
      // Still registered and heartbeating without the device.
      assertEquals(true, host.state().isRegistered)

      // Input while the error is surfaced is dropped without another bind.
      assertFalse(input(host, pixel.deviceId))
      assertEquals(MAX_BIND_ATTEMPTS, transport.boundDevices().size)

      // Retry is one more bounded round.
      transport.unrelatedBindFailures = 0
      host.state().requestControl(pixel.deviceId)
      mainClock.advanceTimeByFrame()
      repeat(2) { tick() }
      assertEquals("emulator-5554", host.state().boundDeviceId)
      assertEquals(null, host.state().bindErrorMessage)
    }

  @Test
  fun `a surfaced bind error is retried automatically on a slow cadence and clears on success`() =
    runComposeUiTest {
      // #10716: no heartbeat lapse and no Retry click.
      val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 99 }
      val host = start(transport, listOf(pixel))
      assertFalse(input(host, pixel.deviceId))

      repeat(10) { tick() }
      assertEquals(MAX_BIND_ATTEMPTS, transport.boundDevices().size)

      // Well inside the cadence: no further attempt.
      repeat(5) { tick() }
      assertEquals(MAX_BIND_ATTEMPTS, transport.boundDevices().size)

      // Past the cadence: exactly one more attempt, which fails and keeps the error surfaced.
      repeat(BIND_ERROR_RETRY_INTERVAL_MS.toInt() / HEARTBEAT_MS.toInt()) { tick() }
      assertEquals(MAX_BIND_ATTEMPTS + 1, transport.boundDevices().size)
      assertEquals("Device 'emulator-5554' not found in device pool", host.state().bindErrorMessage)

      // The device comes back: the next cadence attempt binds and clears the error.
      transport.unrelatedBindFailures = 0
      repeat(BIND_ERROR_RETRY_INTERVAL_MS.toInt() / HEARTBEAT_MS.toInt() + 2) { tick() }
      assertEquals("emulator-5554", host.state().boundDeviceId)
      assertEquals(null, host.state().bindErrorMessage)
    }

  @Test
  fun `a surfaced bind error clears itself once a re-bind after a lapse succeeds`() =
    runComposeUiTest {
      // The device comes back after a daemon restart; no Retry click needed.
      val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 99 }
      val host = start(transport, listOf(pixel))
      assertFalse(input(host, pixel.deviceId))
      repeat(4) { tick() }
      assertEquals("Device 'emulator-5554' not found in device pool", host.state().bindErrorMessage)

      transport.unrelatedBindFailures = 0
      transport.failNext("daemon/heartbeat")
      repeat(2) { tick() }

      assertEquals("emulator-5554", host.state().boundDeviceId)
      assertEquals(null, host.state().bindErrorMessage)
    }

  @Test
  fun `input on a device another session holds is refused and never re-sent`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val host = start(transport, listOf(pixel))

    assertFalse(input(host, pixel.deviceId))
    repeat(10) { tick() }
    // Further input is dropped without another bind.
    assertFalse(input(host, pixel.deviceId))
    repeat(2) { tick() }

    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    // Watching keeps the session alive as an observer instead of allocating the device.
    assertEquals(1, transport.count("daemon/registerSession"))
    assertEquals(12, transport.count("daemon/heartbeat"))
    assertEquals("emulator-5554", host.state().heldElsewhereDeviceId)
    assertEquals(null, host.state().boundDeviceId)
  }

  @Test
  fun `the holder releasing the device does not grab it`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val host = start(transport, listOf(pixel))
    assertFalse(input(host, pixel.deviceId))
    repeat(2) { tick() }

    transport.heldByAnotherSession = false
    repeat(10) { tick() }

    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    assertEquals("emulator-5554", host.state().heldElsewhereDeviceId)
  }

  @Test
  fun `a heartbeat lapse while held elsewhere re-registers without binding`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val host = start(transport, listOf(pixel))
    assertFalse(input(host, pixel.deviceId))
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
    val host = start(transport, listOf(pixel))
    assertFalse(input(host, pixel.deviceId))
    repeat(2) { tick() }
    transport.heldByAnotherSession = false

    host.state().requestControl(pixel.deviceId)
    mainClock.advanceTimeByFrame()
    repeat(5) { tick() }

    assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
    assertEquals(null, host.state().heldElsewhereDeviceId)
    assertEquals("emulator-5554", host.state().boundDeviceId)
    assertTrue(input(host, pixel.deviceId))
  }

  @Test
  fun `take control refused again stays held elsewhere after one attempt`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val host = start(transport, listOf(pixel))
    assertFalse(input(host, pixel.deviceId))
    tick()

    host.state().requestControl(pixel.deviceId)
    mainClock.advanceTimeByFrame()
    repeat(5) { tick() }

    assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
    assertEquals("emulator-5554", host.state().heldElsewhereDeviceId)
  }

  @Test
  fun `take control with a released session uuid binds under a fresh session`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val host = start(transport, listOf(pixel))
    assertFalse(input(host, pixel.deviceId))
    repeat(2) { tick() }
    transport.heldByAnotherSession = false
    transport.releasedSessions += "session-1"

    host.state().requestControl(pixel.deviceId)
    settle()
    repeat(2) { tick() }

    assertEquals(null, host.state().heldElsewhereDeviceId)
    assertEquals(null, host.state().bindErrorMessage)
    assertEquals("emulator-5554", host.state().boundDeviceId)
    assertEquals(3, transport.boundDevices().size)
    assertEquals("session-2", host.state().sessionUuidProvider())
  }

  @Test
  fun `closing the refused pane clears its held-elsewhere notice`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldByAnotherSession = true }
    val host = start(transport, listOf(pixel))
    assertFalse(input(host, pixel.deviceId))
    tick()

    host.panes.value = emptyList()
    settle()

    assertEquals(null, host.state().heldElsewhereDeviceId)
    assertEquals(0, transport.count("daemon/releaseSession"))
  }

  @Test
  fun `no pane never binds and a pane that opens only watches`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val host = start(transport, emptyList())
    repeat(5) { tick() }

    host.panes.value = listOf(pixel)
    settle()
    repeat(3) { tick() }

    assertEquals(emptyList(), transport.boundDevices())
    assertEquals(8, transport.count("daemon/heartbeat"))
  }

  @Test
  fun `input on a device no pane shows is dropped and binds nothing`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val host = start(transport, listOf(pixel))

    assertFalse(input(host, pixelFold.deviceId))
    repeat(2) { tick() }

    assertEquals(emptyList(), transport.boundDevices())
  }

  @Test
  fun `closing the pane of the held device releases it and stops its heartbeat`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val host = start(transport, listOf(pixel))
      assertTrue(input(host, pixel.deviceId))
      repeat(2) { tick() }
      assertEquals(0, transport.count("daemon/releaseSession"))

      host.panes.value = emptyList()
      settle()
      val heartbeatsAtClose = transport.sessionsFor("daemon/heartbeat").count { it == "session-1" }
      repeat(3) { tick() }

      assertEquals(listOf<String?>("session-1"), transport.sessionsFor("daemon/releaseSession"))
      assertEquals(
        heartbeatsAtClose,
        transport.sessionsFor("daemon/heartbeat").count { it == "session-1" },
      )
      assertEquals(3, transport.sessionsFor("daemon/heartbeat").count { it == "session-2" })
    }

  @Test
  fun `reopening a closed pane only watches until the next input binds under a fresh session`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val host = start(transport, listOf(pixel))
      assertTrue(input(host, pixel.deviceId))
      repeat(2) { tick() }
      host.panes.value = emptyList()
      settle()
      repeat(2) { tick() }

      host.panes.value = listOf(pixel)
      settle()
      repeat(2) { tick() }
      assertEquals(listOf("emulator-5554"), transport.boundDevices())

      assertTrue(input(host, pixel.deviceId))
      repeat(2) { tick() }
      assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
      assertEquals(1, transport.count("daemon/releaseSession"))
      assertEquals("session-2", host.state().sessionUuidProvider())
    }

  @Test
  fun `input on a device held elsewhere releases the device this session holds`() =
    runComposeUiTest {
      // #10682 C3: the daemon refuses the new device before rebinding, so the session would keep
      // holding the old device (and heartbeating it) while the pane only watches the new one.
      val transport = RecordingDaemonTransport().apply { heldDeviceIds += pixelFold.deviceId }
      val host = start(transport, listOf(pixel, pixelFold))
      assertTrue(input(host, pixel.deviceId))
      repeat(2) { tick() }

      assertFalse(input(host, pixelFold.deviceId))
      val oldSessionHeartbeats =
        transport.sessionsFor("daemon/heartbeat").count { it == "session-1" }
      repeat(3) { tick() }

      assertEquals(listOf<String?>("session-1"), transport.sessionsFor("daemon/releaseSession"))
      assertEquals(
        oldSessionHeartbeats,
        transport.sessionsFor("daemon/heartbeat").count { it == "session-1" },
      )
      assertEquals(3, transport.sessionsFor("daemon/heartbeat").count { it == "session-2" })
      // The refusal is not re-sent under the fresh session.
      assertEquals(listOf("emulator-5554", "emulator-5556"), transport.boundDevices())
      assertEquals("emulator-5556", host.state().heldElsewhereDeviceId)
      assertEquals(null, host.state().boundDeviceId)
      // The fresh session holds nothing, so closing the panes releases nothing more.
      host.panes.value = emptyList()
      settle()
      repeat(2) { tick() }
      assertEquals(1, transport.count("daemon/releaseSession"))
    }

  @Test
  fun `a failed bind to another device releases the device this session holds`() =
    runComposeUiTest {
      // The daemon throws before rebinding, so session-1 would keep holding pixel (invisible to
      // every other session) behind a pane that cannot use the new device.
      val transport = RecordingDaemonTransport()
      val host = start(transport, listOf(pixel, pixelFold))
      assertTrue(input(host, pixel.deviceId))
      repeat(2) { tick() }

      transport.unrelatedBindFailures = 99
      assertFalse(input(host, pixelFold.deviceId))
      repeat(MAX_BIND_ATTEMPTS) { tick() }
      settle()
      val freshHeartbeats = transport.sessionsFor("daemon/heartbeat").count { it == "session-2" }
      repeat(3) { tick() }

      assertEquals(listOf<String?>("session-1"), transport.sessionsFor("daemon/releaseSession"))
      // The fresh session shows the error without re-running the bounded retries.
      assertEquals(1 + MAX_BIND_ATTEMPTS, transport.boundDevices().size)
      assertEquals("Device 'emulator-5554' not found in device pool", host.state().bindErrorMessage)
      assertEquals("emulator-5556", host.state().bindErrorDeviceId)
      assertEquals(null, host.state().boundDeviceId)
      assertEquals(true, host.state().isRegistered)
      assertEquals(
        freshHeartbeats + 3,
        transport.sessionsFor("daemon/heartbeat").count { it == "session-2" },
      )
    }

  @Test
  fun `a failed bind without a held device stays on the same session`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { unrelatedBindFailures = 99 }
    val host = start(transport, listOf(pixel))
    assertFalse(input(host, pixel.deviceId))
    repeat(6) { tick() }

    assertEquals(0, transport.count("daemon/releaseSession"))
    assertEquals(setOf<String?>("session-1"), transport.sessionsFor("daemon/heartbeat").toSet())
    assertEquals("session-1", host.state().sessionUuidProvider())
  }

  @Test
  fun `a refused bind is not a device hold so closing the pane releases nothing`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport(rejectBindsUntilAttempt = 99)
      val host = start(transport, listOf(pixel))
      assertFalse(input(host, pixel.deviceId))
      repeat(2) { tick() }

      host.panes.value = emptyList()
      settle()
      repeat(2) { tick() }

      assertEquals(0, transport.count("daemon/releaseSession"))
    }

  @Test
  fun `hiding the host past the grace releases the held device and showing it only watches`() =
    runComposeUiTest {
      // #10695: a window closed to the tray (or a hidden IDE tool window) keeps its composition,
      // so the device would stay held with nobody looking at it.
      val transport = RecordingDaemonTransport()
      val host = start(transport, listOf(pixel))
      assertTrue(input(host, pixel.deviceId))
      repeat(2) { tick() }

      host.visible.value = false
      mainClock.advanceTimeByFrame()
      repeat((HIDDEN_RELEASE_GRACE_MS / HEARTBEAT_MS).toInt() + 1) { tick() }
      settle()
      repeat(2) { tick() }

      assertEquals(listOf<String?>("session-1"), transport.sessionsFor("daemon/releaseSession"))
      assertEquals(listOf("emulator-5554"), transport.boundDevices())
      assertEquals(null, host.state().boundDeviceId)
      assertEquals("emulator-5554", host.state().idleReleasedDeviceId)
      assertEquals("session-2", host.state().sessionUuidProvider())

      // Showing the window again binds nothing on its own.
      host.visible.value = true
      mainClock.advanceTimeByFrame()
      repeat(3) { tick() }
      assertEquals(listOf("emulator-5554"), transport.boundDevices())

      // The first input on the pane binds it once under the fresh session.
      assertTrue(input(host, pixel.deviceId))
      repeat(2) { tick() }
      assertEquals(listOf("emulator-5554", "emulator-5554"), transport.boundDevices())
      assertEquals("emulator-5554", host.state().boundDeviceId)
      assertEquals(null, host.state().idleReleasedDeviceId)
      assertEquals(1, transport.count("daemon/releaseSession"))
    }

  @Test
  fun `a hide shorter than the grace keeps the device bound`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val host = start(transport, listOf(pixel))
    assertTrue(input(host, pixel.deviceId))
    repeat(2) { tick() }

    host.visible.value = false
    mainClock.advanceTimeByFrame()
    repeat(2) { tick() }
    host.visible.value = true
    mainClock.advanceTimeByFrame()
    repeat((HIDDEN_RELEASE_GRACE_MS / HEARTBEAT_MS).toInt() + 2) { tick() }

    assertEquals(0, transport.count("daemon/releaseSession"))
    assertEquals(listOf("emulator-5554"), transport.boundDevices())
    assertEquals("emulator-5554", host.state().boundDeviceId)
    assertEquals(null, host.state().idleReleasedDeviceId)
  }

  @Test
  fun `input while the host is hidden past the grace is dropped`() = runComposeUiTest {
    val transport = RecordingDaemonTransport()
    val host = start(transport, listOf(pixel), visible = false)
    repeat((HIDDEN_RELEASE_GRACE_MS / HEARTBEAT_MS).toInt() + 1) { tick() }

    assertFalse(input(host, pixel.deviceId))
    repeat(3) { tick() }

    assertEquals(emptyList(), transport.boundDevices())
  }

  @Test
  fun `the blocking allocation answers at once for a held or refused device`() = runComposeUiTest {
    val transport = RecordingDaemonTransport().apply { heldDeviceIds += pixelFold.deviceId }
    val host = start(transport, listOf(pixel, pixelFold))
    assertTrue(input(host, pixel.deviceId))
    tick()

    // Held by this session: no wait and no frame.
    assertTrue(host.state().inputAllocation.awaitInputAllowed(pixel.deviceId))
    assertFalse(input(host, pixelFold.deviceId))
    // Refused: dropped at once, and never re-sent.
    assertFalse(host.state().inputAllocation.awaitInputAllowed(pixelFold.deviceId))
    assertEquals(listOf("emulator-5554", "emulator-5556"), transport.boundDevices())
  }

  @Test
  fun `the blocking allocation drops an input whose allocation does not finish in time`() =
    runComposeUiTest {
      val transport = RecordingDaemonTransport()
      val host = start(transport, listOf(pixel), inputAllocationTimeoutMs = 1L)

      // The UI clock is not advanced, so the allocation cannot run before the deadline.
      assertFalse(host.state().inputAllocation.awaitInputAllowed(pixel.deviceId))
    }

  private var sessionCounter = 0

  private fun ComposeUiTest.tick() {
    mainClock.advanceTimeBy(HEARTBEAT_MS)
    mainClock.advanceTimeByFrame()
  }

  /**
   * Lets a pane change, an input or a session rotation recompose and restart the session effect.
   */
  private fun ComposeUiTest.settle() {
    repeat(3) { mainClock.advanceTimeByFrame() }
  }

  /** One input's allocation, as the input clients wait on it. Returns whether it was allowed. */
  private fun ComposeUiTest.input(host: Host, deviceId: String): Boolean {
    val allocation: Deferred<Boolean> = host.state().requestInput(deviceId)
    settle()
    assertTrue(allocation.isCompleted, "allocating $deviceId did not finish")
    return runBlocking { allocation.await() }
  }

  private fun ComposeUiTest.start(
    transport: RecordingDaemonTransport,
    panes: List<DesktopDaemonSessionBinding>,
    visible: Boolean = true,
    inputAllocationTimeoutMs: Long = INPUT_ALLOCATION_TIMEOUT_MS,
  ): Host {
    val host = Host(transport, panes, visible, inputAllocationTimeoutMs)
    setContent { host.compose() }
    mainClock.autoAdvance = false
    mainClock.advanceTimeByFrame()
    return host
  }

  private inner class Host(
    private val transport: RecordingDaemonTransport,
    panes: List<DesktopDaemonSessionBinding>,
    visible: Boolean,
    private val inputAllocationTimeoutMs: Long,
  ) {
    val panes: MutableState<List<DesktopDaemonSessionBinding>> = mutableStateOf(panes)
    val visible: MutableState<Boolean> = mutableStateOf(visible)
    private var state: DesktopDaemonSessionState? = null

    fun state(): DesktopDaemonSessionState = requireNotNull(state)

    @Composable
    fun compose() {
      state =
        rememberDesktopDaemonSession(
          socketPath = "in-memory",
          panes = panes,
          hostVisible = visible.value,
          inputAllocationTimeoutMs = inputAllocationTimeoutMs,
          sessionFactory = {
            DesktopDaemonSession(
              McpDaemonClient(transport, sessionUuid = "session-${++sessionCounter}"),
            )
          },
          ioDispatcher = Dispatchers.Unconfined,
          cleanupDispatcher = Dispatchers.Unconfined,
        )
    }
  }

  private companion object {
    const val HEARTBEAT_MS = 2_000L
  }
}
