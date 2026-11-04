package dev.jasonpearson.automobile.desktop.core.daemon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.runComposeUiTest
import dev.jasonpearson.automobile.desktop.core.control.DeviceControlSession
import dev.jasonpearson.automobile.desktop.core.control.RememberDeviceControlOptions
import dev.jasonpearson.automobile.desktop.core.control.TestSnapshotSpec
import dev.jasonpearson.automobile.desktop.core.control.rememberDeviceControlSession
import dev.jasonpearson.automobile.desktop.core.control.testSnapshot
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import java.util.concurrent.Executors
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Studio UI transitions replayed against the REAL daemon's answers (#10669, #10730).
 *
 * Each test drives [rememberDesktopDaemonSession] through one transition while
 * [FixtureReplayDaemonTransport] answers from `test/fixtures/desktop-wire/<scenario>.json`, which
 * `test/daemon/desktopWireContract.test.ts` generates by sending the same frames to the daemon's
 * real handlers. The replay fails if this client sends a frame the fixture did not record (a
 * client-only wire change, as #8911 was), and the fixture drift check fails if the daemon's answer
 * changes; either way both sides are regenerated and re-checked together.
 *
 * Every tap goes through the production control path, `rememberDeviceControlSession` over the real
 * `InputAllocatingClient` and the session's `DesktopInputAllocation` (#11443), so the replay also
 * proves the client claims the device before input reaches the daemon.
 *
 * Owner decisions 2026-10-08: watching allocates nothing, the first tap allocates the device, later
 * taps refresh it, and an idle release drops back to watching without re-binding.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopWireFixtureCompositionTest {
  private val pixel = DesktopDaemonSessionBinding("emulator-5554", "android")
  private val pixelFold = DesktopDaemonSessionBinding("emulator-5556", "android")

  @Test
  fun `ten minutes of watching a focused device allocates nothing`() = runComposeUiTest {
    val replay = Replay("watching-allocates-nothing", listOf(pixel))
    replay.start(this)
    repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }

    replay.transport.assertReplayed()
    assertEquals(null, replay.state().boundDeviceId)
    assertEquals(null, replay.state().heldElsewhereDeviceId)
    assertEquals(true, replay.state().isRegistered)
  }

  @Test
  fun `the first tap binds once before the tap and then only heartbeats`() = runComposeUiTest {
    val replay = Replay("first-tap-binds-device", listOf(pixel))
    replay.start(this)
    repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
    assertEquals(null, replay.state().boundDeviceId)

    assertTrue(tap(replay, pixel.deviceId))
    repeat(replay.fixture.ticks("heartbeat")) { tick() }

    replay.transport.assertReplayed()
    assertEquals("emulator-5554", replay.state().boundDeviceId)
  }

  @Test
  fun `app start with no pane registers deviceless and binds nothing`() = runComposeUiTest {
    val replay = Replay("no-click-start", panes = emptyList())
    replay.start(this)
    repeat(replay.fixture.ticks("heartbeat")) { tick() }

    replay.transport.assertReplayed()
    assertEquals(null, replay.state().boundDeviceId)
    assertEquals(true, replay.state().isRegistered)
  }

  @Test
  fun `a tap on a held device is dropped, the pane keeps watching, and take control binds`() =
    runComposeUiTest {
      val replay = Replay("held-by-another-session", listOf(pixel))
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }

      assertFalse(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat-viewing")) { tick() }
      assertEquals("emulator-5554", replay.state().heldElsewhereDeviceId)

      // The holder releases the device: a later tap is still dropped without any frame.
      assertFalse(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat-after-holder-release")) { tick() }

      replay.transport.assertReplayed(throughLabel = "heartbeat-after-holder-release")
      assertEquals("emulator-5554", replay.state().heldElsewhereDeviceId)
      assertEquals(null, replay.state().boundDeviceId)

      replay.state().requestControl(pixel.deviceId)
      mainClock.advanceTimeByFrame()
      repeat(replay.fixture.ticks("heartbeat-controlling")) { tick() }
      assertTrue(tap(replay, pixel.deviceId))

      replay.transport.assertReplayed()
      assertEquals(null, replay.state().heldElsewhereDeviceId)
      assertEquals("emulator-5554", replay.state().boundDeviceId)
    }

  @Test
  fun `closing the tapped pane releases the device and reopening it only watches`() =
    runComposeUiTest {
      val replay = Replay("close-pane-releases-device", listOf(pixel))
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
      assertTrue(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat")) { tick() }

      replay.panes.value = emptyList()
      settle()
      repeat(replay.fixture.ticks("heartbeat-closed")) { tick() }
      replay.transport.assertReplayed(throughLabel = "heartbeat-closed")
      assertEquals(null, replay.state().boundDeviceId)

      replay.panes.value = listOf(pixel)
      settle()
      repeat(replay.fixture.ticks("heartbeat-reopened")) { tick() }
      replay.transport.assertReplayed(throughLabel = "heartbeat-reopened")
      assertEquals(null, replay.state().boundDeviceId)

      assertTrue(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat-tapped")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5554", replay.state().boundDeviceId)
      assertEquals(
        replay.fixture.sessions.getValue("desktop-2"),
        replay.state().sessionUuidProvider(),
      )
    }

  @Test
  fun `quitting releases the held device and sends nothing after`() = runComposeUiTest {
    val replay = Replay("quit-releases-device", listOf(pixel))
    val shown = mutableStateOf(true)
    replay.start(this, shown)
    repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
    assertTrue(tap(replay, pixel.deviceId))
    repeat(replay.fixture.ticks("heartbeat")) { tick() }

    shown.value = false
    settle()
    repeat(3) { tick() }

    replay.transport.assertReplayed()
  }

  @Test
  fun `hiding the host past the grace after a tap releases the device and showing it only watches`() =
    runComposeUiTest {
      // #10695
      val replay = Replay("hidden-window-release", listOf(pixel))
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
      assertTrue(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat")) { tick() }

      replay.visible.value = false
      mainClock.advanceTimeByFrame()
      repeat(replay.fixture.ticks("heartbeat-hidden")) { tick() }
      settle()
      repeat(replay.fixture.ticks("heartbeat-released")) { tick() }
      replay.transport.assertReplayed(throughLabel = "heartbeat-released")
      assertEquals(null, replay.state().boundDeviceId)
      assertEquals("emulator-5554", replay.state().idleReleasedDeviceId)
      assertEquals(SessionReleaseReason.HIDDEN_WINDOW, replay.state().releaseReason)

      replay.visible.value = true
      mainClock.advanceTimeByFrame()
      repeat(replay.fixture.ticks("heartbeat-shown")) { tick() }
      replay.transport.assertReplayed(throughLabel = "heartbeat-shown")

      assertTrue(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat-rebound")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5554", replay.state().boundDeviceId)
      assertEquals(null, replay.state().idleReleasedDeviceId)
    }

  @Test
  fun `tapping a held device releases the previously tapped one and watches the held one`() =
    runComposeUiTest {
      // #10697: the daemon refuses before rebinding, so the old hold is dropped by rotating.
      val replay = Replay("tap-held-device-releases-previous", listOf(pixel, pixelFold))
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
      assertTrue(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat")) { tick() }

      assertFalse(tap(replay, pixelFold.deviceId))
      repeat(replay.fixture.ticks("heartbeat-viewing")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5556", replay.state().heldElsewhereDeviceId)
      assertEquals(null, replay.state().boundDeviceId)
    }

  @Test
  fun `an idle release drops back to watching and the next tap allocates again`() =
    runComposeUiTest {
      // #10693 / #10730: the daemon would accept a re-sent bind of the idle-released UUID, so the
      // client must not send one. It rotates to a fresh observer session instead.
      val replay = Replay("idle-release", listOf(pixel))
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
      assertTrue(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat")) { tick() }
      tick() // heartbeat-lapse, then the release and the fresh registration
      settle()
      repeat(replay.fixture.ticks("heartbeat-watching-after-release")) { tick() }

      replay.transport.assertReplayed(throughLabel = "heartbeat-watching-after-release")
      assertEquals(null, replay.state().boundDeviceId)
      assertEquals("emulator-5554", replay.state().idleReleasedDeviceId)
      assertEquals(SessionReleaseReason.IDLE, replay.state().releaseReason)
      assertEquals(
        replay.fixture.sessions.getValue("desktop-2"),
        replay.state().sessionUuidProvider(),
      )

      assertTrue(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat-after-tap")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5554", replay.state().boundDeviceId)
      assertEquals(null, replay.state().idleReleasedDeviceId)
    }

  @Test
  fun `a tap every minute keeps one allocation`() = runComposeUiTest {
    val replay = Replay("input-keeps-session", listOf(pixel))
    replay.start(this)
    repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
    assertTrue(tap(replay, pixel.deviceId))
    for (minute in 1..10) {
      repeat(replay.fixture.ticks("heartbeat-minute-$minute")) { tick() }
      assertTrue(tap(replay, pixel.deviceId), "tap in minute $minute")
    }
    repeat(replay.fixture.ticks("heartbeat-after-taps")) { tick() }

    replay.transport.assertReplayed()
    assertEquals("emulator-5554", replay.state().boundDeviceId)
  }

  @Test
  fun `a daemon restart drops back to watching under a fresh session`() = runComposeUiTest {
    val replay = Replay("daemon-restart", listOf(pixel))
    replay.start(this)
    repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
    assertTrue(tap(replay, pixel.deviceId))
    repeat(replay.fixture.ticks("heartbeat")) { tick() }
    tick() // heartbeat-lapse, then the release and the fresh registration
    settle()
    repeat(replay.fixture.ticks("heartbeat-after-restart")) { tick() }
    assertEquals(null, replay.state().boundDeviceId)

    assertTrue(tap(replay, pixel.deviceId))
    repeat(replay.fixture.ticks("heartbeat-after-tap")) { tick() }

    replay.transport.assertReplayed()
    assertEquals("emulator-5554", replay.state().boundDeviceId)
    assertEquals(
      replay.fixture.sessions.getValue("desktop-2"),
      replay.state().sessionUuidProvider(),
    )
  }

  @Test
  fun `a heartbeat-expired session watches under a fresh session instead of re-binding`() =
    runComposeUiTest {
      val replay = Replay("heartbeat-expiry", listOf(pixel))
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
      assertTrue(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat")) { tick() }
      tick() // heartbeat-lapse, then the release and the fresh registration
      settle()
      repeat(replay.fixture.ticks("heartbeat-fresh")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5554", replay.state().idleReleasedDeviceId)
      assertEquals(SessionReleaseReason.HEARTBEAT_LAPSED, replay.state().releaseReason)
      assertEquals(null, replay.state().boundDeviceId)
      assertEquals(null, replay.state().bindErrorMessage)
      assertEquals(
        replay.fixture.sessions.getValue("desktop-2"),
        replay.state().sessionUuidProvider(),
      )
    }

  @Test
  fun `a tap after a terminal release allocates under a fresh session and then goes through`() =
    runComposeUiTest {
      val replay = Replay("released-session-tap", listOf(pixel, pixelFold))
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
      assertTrue(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat")) { tick() }

      // The reaper released the session before the next heartbeat; the user taps the fold pane.
      assertTrue(tap(replay, pixelFold.deviceId))
      repeat(replay.fixture.ticks("heartbeat-fresh")) { tick() }

      replay.transport.assertReplayed()
      assertEquals("emulator-5556", replay.state().boundDeviceId)
      assertEquals(
        replay.fixture.sessions.getValue("desktop-2"),
        replay.state().sessionUuidProvider(),
      )
    }

  @Test
  fun `a non-ownership bind error drops the tap, is retried, then surfaced, never held elsewhere`() =
    runComposeUiTest {
      // #10696
      val replay = Replay("bind-error-not-ownership", listOf(pixel))
      replay.start(this)
      repeat(replay.fixture.ticks("heartbeat-watching")) { tick() }
      assertFalse(tap(replay, pixel.deviceId))
      repeat(replay.fixture.ticks("heartbeat-1")) { tick() }
      repeat(replay.fixture.ticks("heartbeat-2")) { tick() }
      repeat(replay.fixture.ticks("heartbeat-surfaced")) { tick() }

      replay.transport.assertReplayed()
      assertEquals(null, replay.state().heldElsewhereDeviceId)
      assertEquals(null, replay.state().boundDeviceId)
      assertEquals(
        "Device 'emulator-5554' not found in device pool",
        replay.state().bindErrorMessage,
      )
      assertEquals("emulator-5554", replay.state().bindErrorDeviceId)
    }

  /**
   * One pane tap through the production control path (#11443): the host's
   * [rememberDeviceControlSession] wraps the replay's client in the real [InputAllocatingClient],
   * which blocks on the session's real [DesktopInputAllocation] before `input/tap` reaches the
   * transport. The dispatch runs on the control worker thread, as it does in the app, while this
   * thread drives the composition that completes the allocation. Returns whether the tap was sent.
   *
   * So a client that skips the allocation (mutant n/K2) or a control session handed the raw
   * provider (mutant K3) sends a tap the fixture did not record, or no bind before it, and the
   * replay diverges.
   */
  private fun ComposeUiTest.tap(replay: Replay, deviceId: String): Boolean {
    val outcome = replay.expectTap()
    assertTrue(replay.control().tap(testSnapshot(TestSnapshotSpec(deviceId = deviceId)), TAP_POINT))
    var frames = 0
    while (!outcome.isCompleted && frames < MAX_TAP_FRAMES) {
      // Give the worker real time to reach the allocation gate (or finish) before the next frame.
      runBlocking { withTimeoutOrNull(TAP_WAIT_MS) { outcome.await() } }
      if (!outcome.isCompleted) {
        mainClock.advanceTimeByFrame()
        frames++
      }
    }
    // Keep each tap to the same frame budget so the heartbeat schedule matches the fixture.
    repeat((SETTLE_FRAMES - frames).coerceAtLeast(0)) { mainClock.advanceTimeByFrame() }
    assertTrue(outcome.isCompleted, "tapping $deviceId did not finish in $frames frames")
    return when (val result = runBlocking { outcome.await() }) {
      is TapOutcome.Sent -> {
        assertTrue(result.result.success, "tap on $deviceId: ${result.result.error}")
        true
      }
      is TapOutcome.Dropped -> {
        assertEquals(INPUT_NOT_ALLOCATED_ERROR, result.error, "tap on $deviceId")
        false
      }
    }
  }

  /**
   * One heartbeat interval, exactly: the trailing frame that flushes recomposition is part of the
   * interval, so the hundreds of ticks in the ten-minute scenarios do not drift into extra beats.
   */
  private fun ComposeUiTest.tick() {
    mainClock.advanceTimeBy(HEARTBEAT_MS - FRAME_MS)
    mainClock.advanceTimeByFrame()
  }

  /**
   * Lets a pane change, an input or a session rotation recompose and restart the session effect.
   */
  private fun ComposeUiTest.settle() {
    repeat(SETTLE_FRAMES) { mainClock.advanceTimeByFrame() }
  }

  private sealed interface TapOutcome {
    /** The allocation allowed the tap and the client sent it; the daemon's answer. */
    data class Sent(val result: InputActionResult) : TapOutcome

    /** The tap never reached the transport; the error the pane showed. */
    data class Dropped(val error: String) : TapOutcome
  }

  /**
   * The replay's daemon client as the control session's provider yields it. The fixture daemon has
   * no observation stream, so the recorded `input/tap` frames carry no `frameContext`; this drops
   * the snapshot's context before the frame is built. It sits UNDER the production allocation
   * wrapper, so it cannot send anything the allocation did not allow.
   *
   * Like the app's per-action client (`inputSessionUuidProvider`), it resolves the desktop session
   * when the tap is sent, not when it was enqueued: the allocation can rotate to a fresh session
   * between the two.
   */
  private class FixtureInputClient(
    private val current: () -> McpDaemonClient,
    private val onSent: (InputActionResult) -> Unit,
  ) : AutoMobileClient by current() {
    override fun inputTap(input: TapInput): InputActionResult =
      current().inputTap(input.copy(frameContext = null)).also(onSent)
  }

  private inner class Replay(
    scenario: String,
    panes: List<DesktopDaemonSessionBinding>,
    private val testDispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Unconfined,
  ) {
    val fixture = DesktopWireFixture.load(scenario)
    val transport = FixtureReplayDaemonTransport(fixture)
    val panes: MutableState<List<DesktopDaemonSessionBinding>> = mutableStateOf(panes)
    val visible = mutableStateOf(true)
    private var state: DesktopDaemonSessionState? = null
    private var control: DeviceControlSession? = null
    private var minted = 0
    @Volatile private var pendingTap: CompletableDeferred<TapOutcome>? = null
    private val controlScope = CoroutineScope(SupervisorJob() + CONTROL_WORKER)
    // Stable across recompositions: a new provider resets the control session's queue.
    private val inputClientProvider: () -> AutoMobileClient = {
      FixtureInputClient(::client) { pendingTap?.complete(TapOutcome.Sent(it)) }
    }

    fun state(): DesktopDaemonSessionState = requireNotNull(state)

    fun control(): DeviceControlSession = requireNotNull(control)

    fun client(): McpDaemonClient = requireNotNull(state().session).client

    fun expectTap(): CompletableDeferred<TapOutcome> =
      CompletableDeferred<TapOutcome>().also { pendingTap = it }

    fun start(test: ComposeUiTest, shown: MutableState<Boolean> = mutableStateOf(true)) {
      test.setContent { if (shown.value) state = host() }
      test.mainClock.autoAdvance = false
      test.mainClock.advanceTimeByFrame()
    }

    @Composable
    private fun host(): DesktopDaemonSessionState {
      val session = hostSession()
      control =
        rememberDeviceControlSession(
          session,
          RememberDeviceControlOptions(
            scope = controlScope,
            clientProvider = inputClientProvider,
            platform = { "android" },
            nowMs = { 1_000L },
            publishError = { error ->
              if (error != null) pendingTap?.complete(TapOutcome.Dropped(error))
            },
            streamingEnabled = false,
            uiContext = testDispatcher,
            ioDispatcher = CONTROL_WORKER,
          ),
        )
      return session
    }

    @Composable
    private fun hostSession(): DesktopDaemonSessionState =
      rememberDesktopDaemonSession(
        DesktopDaemonSessionOptions(
          socketPath = "in-memory",
          panes = panes,
          hostVisible = visible.value,
          bindRetryBackoff = { BIND_ERROR_RETRY_MAX_DELAY_MS },
          sessionFactory = {
            val uuid = fixture.sessions.getValue("desktop-${++minted}")
            DesktopDaemonSession(McpDaemonClient(transport, sessionUuid = uuid))
          },
          ioDispatcher = testDispatcher,
          cleanupDispatcher = testDispatcher,
        ),
      )
  }

  private companion object {
    const val HEARTBEAT_MS = 2_000L
    const val FRAME_MS = 16L
    const val SETTLE_FRAMES = 3
    const val MAX_TAP_FRAMES = 20
    const val TAP_WAIT_MS = 50L
    val TAP_POINT = DevicePoint(x = 540, y = 1200, inBounds = true)

    /** The control session's dispatch thread: the app runs input off the UI thread too. */
    val CONTROL_WORKER =
      Executors.newSingleThreadExecutor { runnable ->
          Thread(runnable, "wire-replay-control").apply { isDaemon = true }
        }
        .asCoroutineDispatcher()
  }
}
