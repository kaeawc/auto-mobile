package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers

/**
 * Studio UI transitions replayed against the REAL daemon's answers (#10669).
 *
 * Each test drives [rememberDesktopDaemonSession] through one transition while
 * [FixtureReplayDaemonTransport] answers from `test/fixtures/desktop-wire/<scenario>.json`, which
 * `test/daemon/desktopWireContract.test.ts` generates by sending the same frames to the daemon's
 * real handlers. The replay fails if this client sends a frame the fixture did not record (a
 * client-only wire change, as #8911 was), and the fixture drift check fails if the daemon's answer
 * changes; either way both sides are regenerated and re-checked together.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopWireFixtureCompositionTest {
  private val pixel = DesktopDaemonSessionBinding("emulator-5554", "android")
  private val pixelFold = DesktopDaemonSessionBinding("emulator-5556", "android")

  @Test
  fun `focus binds once and then only heartbeats`() = runComposeUiTest {
    val replay = Replay("focus-binds-device", pixel)
    replay.start(this)
    repeat(replay.fixture.ticks("heartbeat")) { tick() }

    replay.transport.assertReplayed()
    assertEquals("emulator-5554", replay.state().boundDeviceId)
    assertEquals(null, replay.state().viewingDeviceId)
  }

  @Test
  fun `app start with no click registers deviceless and binds nothing`() = runComposeUiTest {
    val replay = Replay("no-click-start", binding = null)
    replay.start(this)
    repeat(replay.fixture.ticks("heartbeat")) { tick() }

    replay.transport.assertReplayed()
    assertEquals(null, replay.state().boundDeviceId)
    assertEquals(true, replay.state().isRegistered)
  }

  @Test
  fun `a device another session holds is viewed, not grabbed on release, and taken on request`() =
    runComposeUiTest {
      val replay = Replay("held-by-another-session", pixel)
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-viewing")) { tick() }
      repeat(replay.fixture.ticks("heartbeat-after-holder-release")) { tick() }

      replay.transport.assertReplayed(throughLabel = "heartbeat-after-holder-release")
      assertEquals("emulator-5554", replay.state().viewingDeviceId)
      assertEquals(null, replay.state().boundDeviceId)

      replay.state().requestControl()
      mainClock.advanceTimeByFrame()
      repeat(replay.fixture.ticks("heartbeat-controlling")) { tick() }

      replay.transport.assertReplayed()
      assertEquals(null, replay.state().viewingDeviceId)
      assertEquals("emulator-5554", replay.state().boundDeviceId)
    }

  @Test
  fun `unfocus releases the device and refocus binds under a fresh session`() = runComposeUiTest {
    val replay = Replay("unfocus-releases-device", pixel)
    replay.start(this)
    repeat(replay.fixture.ticks("heartbeat")) { tick() }

    replay.binding.value = null
    settle()
    repeat(replay.fixture.ticks("heartbeat-unfocused")) { tick() }
    replay.transport.assertReplayed(throughLabel = "heartbeat-unfocused")
    assertEquals(null, replay.state().boundDeviceId)

    replay.binding.value = pixel
    settle()
    repeat(replay.fixture.ticks("heartbeat-refocused")) { tick() }

    replay.transport.assertReplayed()
    assertEquals("emulator-5554", replay.state().boundDeviceId)
    assertEquals(
      replay.fixture.sessions.getValue("desktop-2"),
      replay.state().sessionUuidProvider(),
    )
  }

  @Test
  fun `quitting releases the held device and sends nothing after`() = runComposeUiTest {
    val replay = Replay("quit-releases-device", pixel)
    val shown = mutableStateOf(true)
    replay.start(this, shown)
    repeat(replay.fixture.ticks("heartbeat")) { tick() }

    shown.value = false
    settle()
    repeat(3) { tick() }

    replay.transport.assertReplayed()
  }

  @Test
  fun `hiding the host past the grace releases the device and the first tap re-binds it`() =
    runComposeUiTest {
      // #10695
      val replay = Replay("hidden-window-release", pixel)
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat")) { tick() }

      replay.visible.value = false
      mainClock.advanceTimeByFrame()
      repeat(replay.fixture.ticks("heartbeat-hidden")) { tick() }
      settle()
      repeat(replay.fixture.ticks("heartbeat-released")) { tick() }
      replay.transport.assertReplayed(throughLabel = "heartbeat-released")
      assertEquals(null, replay.state().boundDeviceId)
      assertEquals("emulator-5554", replay.state().idleReleasedDeviceId)

      replay.visible.value = true
      mainClock.advanceTimeByFrame()
      replay.state().onUserInteraction("emulator-5554")
      val tap = replay.client().inputTap(540.0, 1200.0, "android", "emulator-5554")
      assertTrue(tap.success, "tap after showing the host: ${tap.error}")
      settle()
      repeat(replay.fixture.ticks("heartbeat-rebound")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5554", replay.state().boundDeviceId)
      assertEquals(null, replay.state().idleReleasedDeviceId)
    }

  @Test
  fun `focusing a held device releases the previously bound one and views the held one`() =
    runComposeUiTest {
      // #10697: the daemon refuses before rebinding, so the old hold is dropped by rotating.
      val replay = Replay("refused-focus-change", pixel)
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat")) { tick() }

      replay.binding.value = pixelFold
      settle()
      repeat(replay.fixture.ticks("heartbeat-viewing")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5556", replay.state().viewingDeviceId)
      assertEquals(null, replay.state().boundDeviceId)
    }

  @Test
  fun `an idle release is undone by the lapse rebind because the daemon accepts the uuid`() =
    runComposeUiTest {
      // Characterizes #10693 on today's daemon: the idle release (`cleanup-expired`) is not
      // terminal, so the client's automatic re-send of its lost binding succeeds and re-acquires
      // the device. #10730 makes the client fall back to viewing here instead; regenerate the
      // fixture and flip these assertions with that change.
      val replay = Replay("idle-release", pixel)
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat")) { tick() }
      tick() // heartbeat-lapse, then the client re-sends the binding at once
      repeat(replay.fixture.ticks("heartbeat-after-rebind")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5554", replay.state().boundDeviceId)
      assertEquals(null, replay.state().idleReleasedDeviceId)
    }

  @Test
  fun `pane taps keep the focused session bound`() = runComposeUiTest {
    val replay = Replay("input-keeps-session", pixel)
    replay.start(this)
    for (minute in 1..4) {
      repeat(replay.fixture.ticks("heartbeat-minute-$minute")) { tick() }
      replay.state().onUserInteraction("emulator-5554")
      val tap = replay.client().inputTap(540.0, 1200.0, "android", "emulator-5554")
      assertTrue(tap.success, "tap in minute $minute: ${tap.error}")
    }
    repeat(replay.fixture.ticks("heartbeat-after-taps")) { tick() }

    replay.transport.assertReplayed()
    assertEquals("emulator-5554", replay.state().boundDeviceId)
  }

  @Test
  fun `a daemon restart lapse re-binds on its own under the same session`() = runComposeUiTest {
    val replay = Replay("daemon-restart", pixel)
    replay.start(this)
    repeat(replay.fixture.ticks("heartbeat")) { tick() }
    tick() // heartbeat-lapse, then the client re-sends the binding at once
    repeat(replay.fixture.ticks("heartbeat-after-rebind")) { tick() }

    replay.transport.assertReplayed()
    assertEquals("emulator-5554", replay.state().boundDeviceId)
    assertEquals(null, replay.state().idleReleasedDeviceId)
    assertEquals(
      replay.fixture.sessions.getValue("desktop-1"),
      replay.state().sessionUuidProvider(),
    )
  }

  @Test
  fun `a heartbeat-expired session views under a fresh session instead of re-binding`() =
    runComposeUiTest {
      val replay = Replay("heartbeat-expiry", pixel)
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat")) { tick() }
      tick() // heartbeat-lapse, then the re-sent binding is refused as a released session
      settle()
      repeat(replay.fixture.ticks("heartbeat-fresh")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5554", replay.state().idleReleasedDeviceId)
      assertEquals(null, replay.state().boundDeviceId)
      assertEquals(null, replay.state().bindErrorMessage)
      assertEquals(
        replay.fixture.sessions.getValue("desktop-2"),
        replay.state().sessionUuidProvider(),
      )
    }

  @Test
  fun `a non-ownership bind error is retried, then surfaced, never treated as viewing`() =
    runComposeUiTest {
      // #10696
      val replay = Replay("bind-error-not-ownership", pixel)
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-1")) { tick() }
      repeat(replay.fixture.ticks("heartbeat-2")) { tick() }
      repeat(replay.fixture.ticks("heartbeat-surfaced")) { tick() }

      replay.transport.assertReplayed()
      assertEquals(null, replay.state().viewingDeviceId)
      assertEquals(null, replay.state().boundDeviceId)
      assertEquals(
        "Device 'emulator-5554' not found in device pool",
        replay.state().bindErrorMessage,
      )
    }

  private fun ComposeUiTest.tick() {
    mainClock.advanceTimeBy(HEARTBEAT_MS)
    mainClock.advanceTimeByFrame()
  }

  /** Lets a binding change or session rotation recompose and restart the session effect. */
  private fun ComposeUiTest.settle() {
    repeat(3) { mainClock.advanceTimeByFrame() }
  }

  private inner class Replay(scenario: String, binding: DesktopDaemonSessionBinding?) {
    val fixture = DesktopWireFixture.load(scenario)
    val transport = FixtureReplayDaemonTransport(fixture)
    val binding: MutableState<DesktopDaemonSessionBinding?> = mutableStateOf(binding)
    val visible = mutableStateOf(true)
    private var state: DesktopDaemonSessionState? = null
    private var minted = 0

    fun state(): DesktopDaemonSessionState = requireNotNull(state)

    fun client(): McpDaemonClient = requireNotNull(state().session).client

    fun start(test: ComposeUiTest, shown: MutableState<Boolean> = mutableStateOf(true)) {
      test.setContent { if (shown.value) state = host() }
      test.mainClock.autoAdvance = false
      test.mainClock.advanceTimeByFrame()
    }

    @Composable
    private fun host(): DesktopDaemonSessionState =
      rememberDesktopDaemonSession(
        socketPath = "in-memory",
        binding = binding,
        hostVisible = visible.value,
        sessionFactory = {
          val uuid = fixture.sessions.getValue("desktop-${++minted}")
          DesktopDaemonSession(McpDaemonClient(transport, sessionUuid = uuid))
        },
        ioDispatcher = Dispatchers.Unconfined,
        cleanupDispatcher = Dispatchers.Unconfined,
      )
  }

  private companion object {
    const val HEARTBEAT_MS = 2_000L
  }
}
