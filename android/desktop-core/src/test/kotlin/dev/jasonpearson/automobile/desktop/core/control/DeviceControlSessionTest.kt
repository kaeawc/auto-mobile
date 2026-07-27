package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DeviceControlBlockReason
import dev.jasonpearson.automobile.desktop.domain.DeviceControlDecision
import dev.jasonpearson.automobile.desktop.domain.DeviceControlInputs
import dev.jasonpearson.automobile.desktop.domain.DeviceDragGesturePolicy
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.HierarchyFrameFacts
import dev.jasonpearson.automobile.desktop.domain.LiveFrameFacts
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshState
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshTracker
import dev.jasonpearson.automobile.desktop.domain.ScreenshotFrameFacts
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest

/**
 * The single device-control seam (issue #3348): dispatch through the clicked snapshot, error
 * ordering, and the post-input refresh transitions.
 *
 * Everything is injected — daemon client, clock, UI context and IO dispatcher — so these run with
 * no real device, socket or timer.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DeviceControlSessionTest {

  private val point = DevicePoint(x = 360, y = 780, inBounds = true)

  @Test
  fun `a tap is dispatched against the snapshot it was clicked on, not the newest one`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session =
      DeviceControlSession(
        scope = scope,
        clientProvider = { client },
        platform = { "android" },
        nowMs = { 1_000L },
        publishError = {},
        uiContext = UnconfinedTestDispatcher(testScheduler),
        ioDispatcher = UnconfinedTestDispatcher(testScheduler),
      )

    val clicked = testSnapshot(deviceId = "emulator-5554", sequence = 5L)
    session.tap(clicked, point)
    advanceUntilIdle()

    val call = client.inputTapCalls.single()
    assertEquals(360.0, call.x)
    assertEquals(780.0, call.y)
    // The snapshot is the authority for the target device, so a selection change racing the
    // dispatch cannot redirect this tap.
    assertEquals("emulator-5554", call.deviceId)
    scope.cancel()
  }

  @Test
  fun `a successful tap awaits the first superseding snapshot`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val session = session(scope, FakeAutoMobileClient())

    session.tap(testSnapshot(sequence = 5L), point)
    advanceUntilIdle()

    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a failed tap publishes the daemon's actionable error and settles without waiting`() =
    runTest {
      val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
      val client = FakeAutoMobileClient()
      client.inputTapResult =
        InputActionResult(action = "input/tap", success = false, error = "device is locked")
      val published = mutableListOf<String?>()
      val session = session(scope, client, publishError = { published.add(it) })

      session.tap(testSnapshot(sequence = 5L), point)
      advanceUntilIdle()

      // Cleared on attempt, then the daemon's own message — never a generic invented one.
      assertEquals(listOf(null, "device is locked"), published)
      // The device did not change, so there is nothing to wait for and nothing to clear.
      assertEquals(PostInputRefreshState.Settled, session.refreshState)
      scope.cancel()
    }

  @Test
  fun `a superseded tap's late failure cannot resurrect a banner a newer tap cleared`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    client.inputTapResult =
      InputActionResult(action = "input/tap", success = false, error = "stale failure")
    var banner: String? = "previous"
    val session = session(scope, client, publishError = { banner = it })

    // Two clicks in quick succession: the first is dispatched, then a newer one claims the slot
    // before the first's failure is published.
    session.tap(testSnapshot(sequence = 5L), point)
    session.tap(testSnapshot(sequence = 6L), point)
    advanceUntilIdle()

    // Only the newest attempt's error may show. Both fail here, so the banner holds the newest —
    // what must never happen is a *stale* error outliving a newer clear.
    assertEquals("stale failure", banner)
    assertEquals(2, client.inputTapCalls.size)
    scope.cancel()
  }

  @Test
  fun `reset clears the banner and drops a pending refresh wait`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    var banner: String? = "something"
    val session = session(scope, FakeAutoMobileClient(), publishError = { banner = it })

    session.tap(testSnapshot(sequence = 5L), point)
    advanceUntilIdle()
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    session.reset()
    assertNull(banner)
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  private fun kotlinx.coroutines.test.TestScope.session(
    scope: CoroutineScope,
    client: FakeAutoMobileClient,
    publishError: (String?) -> Unit = {},
  ) =
    DeviceControlSession(
      scope = scope,
      clientProvider = { client },
      platform = { "android" },
      nowMs = { 1_000L },
      publishError = publishError,
      uiContext = UnconfinedTestDispatcher(testScheduler),
      ioDispatcher = UnconfinedTestDispatcher(testScheduler),
    )

  @Test
  fun `a reset session drains nothing through the old client`() = runTest {
    // Finding 3/6: when the host's daemon client provider changes (a reconnect) it resets this ONE
    // session and lets the provider swap behind it, rather than building a replacement. A
    // replacement would leave the previous session's consumer running in the host's stable scope,
    // still holding queued commands and their unclosed clients, and would drain them through the
    // superseded client. Reset must leave nothing to drain.
    //
    // StandardTestDispatcher (not Unconfined) so the single consumer is dispatched but has not run
    // yet when the taps are enqueued — the same state a consumer blocked on a stalled daemon is in.
    val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
    val oldClients = mutableListOf<FakeAutoMobileClient>()
    var provider: () -> AutoMobileClient? = { FakeAutoMobileClient().also { oldClients.add(it) } }
    var banner: String? = "stale"
    val session =
      DeviceControlSession(
        scope = scope,
        clientProvider = { provider() },
        platform = { "android" },
        nowMs = { 1_000L },
        publishError = { banner = it },
        uiContext = StandardTestDispatcher(testScheduler),
        ioDispatcher = StandardTestDispatcher(testScheduler),
      )

    repeat(4) { session.tap(testSnapshot(sequence = it.toLong()), point) }
    assertEquals(4, oldClients.size, "each tap mints a client from the provider in force")

    // The host reconnects: reset, then the provider swaps.
    session.reset()
    val newClient = FakeAutoMobileClient()
    provider = { newClient }
    advanceUntilIdle()

    oldClients.forEach { client ->
      assertTrue("close" in client.calls, "a queued client must be closed by reset")
      assertTrue(client.inputTapCalls.isEmpty(), "a queued tap must not forward after reset")
    }
    assertTrue(newClient.inputTapCalls.isEmpty(), "nothing drains through the new client either")
    assertNull(banner, "reset clears the banner")
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `an out-of-bounds tap is a no-op, not a success awaiting a refresh`() = runTest {
    // Finding 7: nothing reaches the device for an off-screen point, so it must not park the
    // client in AwaitingSnapshot for the full refresh timeout.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    val dispatched = session.tap(testSnapshot(), DevicePoint(x = -5, y = 4000, inBounds = false))
    advanceUntilIdle()

    assertFalse(dispatched, "an out-of-bounds point is reported as not dispatched")
    assertTrue(client.inputTapCalls.isEmpty(), "nothing is sent to the daemon")
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a drag past the threshold sends one swipe against the snapshot it began on`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    val dragged =
      session.swipe(
        testSnapshot(deviceId = "emulator-5554", sequence = 5L),
        DevicePoint(x = 540, y = 1800, inBounds = true),
        DevicePoint(x = 540, y = 400, inBounds = true),
      )
    advanceUntilIdle()

    assertTrue(dragged, "a deliberate drag is dispatched")
    val call = client.inputSwipeCalls.single()
    assertEquals(540.0, call.startX)
    assertEquals(1800.0, call.startY)
    assertEquals(540.0, call.endX)
    assertEquals(400.0, call.endY)
    assertEquals("emulator-5554", call.deviceId, "the snapshot is the authority for the device")
    assertEquals(DeviceDragGesturePolicy.SWIPE_DURATION_MS, call.durationMs)
    assertTrue(client.inputTapCalls.isEmpty(), "a swipe must not also fire a tap")
    // The device changed, so the same #3348 refresh policy the tap path uses applies here.
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a below-threshold drag sends nothing and does not park the client awaiting a refresh`() =
    runTest {
      val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
      val client = FakeAutoMobileClient()
      val published = mutableListOf<String?>()
      val session = session(scope, client, publishError = { published.add(it) })

      val dragged =
        session.swipe(
          testSnapshot(),
          DevicePoint(x = 540, y = 1800, inBounds = true),
          DevicePoint(x = 542, y = 1803, inBounds = true),
        )
      advanceUntilIdle()

      assertFalse(dragged, "a movement below the threshold is reported as not dispatched")
      assertTrue(client.inputSwipeCalls.isEmpty(), "nothing is sent to the daemon")
      assertTrue(client.inputTapCalls.isEmpty(), "and it is NOT promoted to a tap")
      // An ignored drag changed nothing on the device, so it must neither start a refresh wait nor
      // touch the error banner (which would clear an error a real attempt just published).
      assertEquals(PostInputRefreshState.Idle, session.refreshState)
      assertEquals(emptyList(), published, "an ignored drag publishes nothing at all")
      scope.cancel()
    }

  @Test
  fun `a drag that started off-screen sends nothing`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    val dragged =
      session.swipe(
        testSnapshot(),
        DevicePoint(x = -30, y = 1800, inBounds = false),
        DevicePoint(x = 540, y = 400, inBounds = true),
      )
    advanceUntilIdle()

    assertFalse(dragged)
    assertTrue(client.inputSwipeCalls.isEmpty())
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a drag that ran off the frame is clamped, never sent off-screen`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    session.swipe(
      testSnapshot(deviceWidth = 1080, deviceHeight = 2340),
      DevicePoint(x = 540, y = 1800, inBounds = true),
      DevicePoint(x = 540, y = 9_000, inBounds = false),
    )
    advanceUntilIdle()

    val call = client.inputSwipeCalls.single()
    assertEquals(2339.0, call.endY, "the end pins to the last addressable row")
    scope.cancel()
  }

  @Test
  fun `a tap and a swipe execute in gesture order on the one queue`() = runTest {
    // The ordering guarantee only holds if both actions travel the SAME queue. A separate swipe
    // path would reintroduce the click-order race #3347 removed.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val snapshot = testSnapshot()

    session.tap(snapshot, point)
    session.swipe(
      snapshot,
      DevicePoint(x = 540, y = 1800, inBounds = true),
      DevicePoint(x = 540, y = 400, inBounds = true),
    )
    session.tap(snapshot, point)
    advanceUntilIdle()

    assertEquals(
      listOf("inputTap", "close", "inputSwipe", "close", "inputTap", "close"),
      client.calls.filter { it == "inputTap" || it == "inputSwipe" || it == "close" },
    )
    scope.cancel()
  }

  @Test
  fun `a failed swipe publishes the daemon's error and settles without waiting`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    client.inputSwipeResult =
      InputActionResult(action = "input/swipe", success = false, error = "device is locked")
    val published = mutableListOf<String?>()
    val session = session(scope, client, publishError = { published.add(it) })

    session.swipe(
      testSnapshot(),
      DevicePoint(x = 540, y = 1800, inBounds = true),
      DevicePoint(x = 540, y = 400, inBounds = true),
    )
    advanceUntilIdle()

    assertEquals(listOf(null, "device is locked"), published)
    assertEquals(PostInputRefreshState.Settled, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a cleared live frame does not move the snapshot sequence backwards`() = runTest {
    // Finding 5: the live frame's counter is a different domain from the observation sources'.
    // Folding it into the snapshot sequence would make the sequence jump while a mirror is
    // connected and fall back when it clears, breaking the refresh policy's strictly-greater
    // settle condition.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val session = session(scope, FakeAutoMobileClient())

    val withMirror =
      paired(captureSequence = 7L, sourceSequence = 10L)
        .copy(
          liveFrame =
            LiveFrameFacts(
              deviceId = "emulator-5554",
              sequence = 900_000L, // a long-running mirror connection
              receivedAtMs = 1_000L,
              width = 1080,
              height = 2340,
            )
        )
    val mirrored = assertNotNull(session.evaluate(withMirror).snapshotOrNull)
    assertEquals(10L, mirrored.sequence, "ordered by the observation counter, not the mirror's")
    assertEquals(900_000L, mirrored.liveFrameSequence, "the mirror's provenance is still carried")

    // Tap through it, then the mirror drops and the next paired observation arrives.
    session.tap(mirrored, point)
    advanceUntilIdle()
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    val withoutMirror = paired(captureSequence = 8L, sourceSequence = 11L)
    val next = assertNotNull(session.evaluate(withoutMirror).snapshotOrNull)
    assertTrue(next.sequence > mirrored.sequence, "the sequence never goes backwards")
    assertNull(next.liveFrameSequence)
    // The settle condition still works across the transition.
    assertEquals(PostInputRefreshState.Settled, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a screenshot-only update does not replace the retained snapshot while awaiting`() = runTest {
    // Finding 4: the refresh policy must have a user-visible effect. After a successful tap the
    // clicked snapshot is RETAINED for rendering until something genuinely supersedes it. A
    // screenshot-only update in the meantime carries a capture id the retained hierarchy does not
    // match, so it produces no snapshot at all — and must not replace what is on screen.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val session = session(scope, FakeAutoMobileClient())

    val clickedPixels = byteArrayOf(1, 1, 1)
    val clicked = paired(captureSequence = 7L, sourceSequence = 10L, data = clickedPixels)
    assertNotNull(session.evaluate(clicked).snapshotOrNull)
    val retained = assertNotNull(session.renderSnapshot)
    assertSame(clickedPixels, retained.screenshotData)

    session.tap(retained, point)
    advanceUntilIdle()
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    // A screenshot-only update lands: new capture id and NEW PIXELS, hierarchy unchanged.
    val newPixels = byteArrayOf(2, 2, 2)
    val screenshotOnly =
      clicked.copy(
        screenshot =
          clicked.screenshot?.copy(
            sequence = 20L,
            captureSequence = 8L,
            width = 720,
            height = 1560,
            data = newPixels,
          )
      )
    assertNull(
      session.evaluate(screenshotOnly).snapshotOrNull,
      "an unpaired update yields no snapshot",
    )
    assertEquals(retained, session.renderSnapshot, "the retained snapshot stays on screen")
    // Finding 3: the PIXELS must not change either. Rendering the new bytes against the retained
    // hierarchy would be the half-updated frame this policy exists to prevent.
    assertSame(
      clickedPixels,
      session.renderSnapshot?.screenshotData,
      "the displayed pixels stay on the clicked snapshot until a paired one supersedes it",
    )
    assertEquals(1080, session.renderSnapshot?.deviceWidth, "and so do the mapping dimensions")
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    // Once the paired hierarchy catches up, the superseding snapshot settles the wait and replaces
    // what is rendered.
    val superseding =
      paired(
        captureSequence = 8L,
        sourceSequence = 21L,
        width = 720,
        height = 1560,
        data = newPixels,
      )
    val next = assertNotNull(session.evaluate(superseding).snapshotOrNull)
    assertEquals(PostInputRefreshState.Settled, session.refreshState)
    assertEquals(next, session.renderSnapshot)
    assertEquals(720, session.renderSnapshot?.deviceWidth)
    assertSame(newPixels, session.renderSnapshot?.screenshotData, "pixels advance only now")
    scope.cancel()
  }

  @Test
  fun `a refresh wait that times out releases the retained snapshot`() = runTest {
    // Finding 3: after a successful tap, if screenshot updates keep arriving but hierarchy updates
    // stall, nothing ever pairs and no live snapshot exists. The wait settles on the timeout — and
    // if the retained snapshot were kept, the view would pin the pre-tap pixels and hierarchy
    // INDEFINITELY, the opposite of a 3s retention bound.
    var now = 1_000L
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val session =
      DeviceControlSession(
        scope = scope,
        clientProvider = { FakeAutoMobileClient() },
        platform = { "android" },
        nowMs = { now },
        publishError = {},
        uiContext = UnconfinedTestDispatcher(testScheduler),
        ioDispatcher = UnconfinedTestDispatcher(testScheduler),
      )

    val clicked = paired(captureSequence = 7L, sourceSequence = 10L, data = byteArrayOf(1))
    assertNotNull(session.evaluate(clicked).snapshotOrNull)
    val retained = assertNotNull(session.renderSnapshot)

    session.tap(retained, point)
    advanceUntilIdle()
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    // Screenshots keep arriving with new capture ids, but the hierarchy is stuck on capture 7, so
    // nothing pairs and every evaluation is Blocked.
    val unpaired =
      clicked.copy(screenshot = clicked.screenshot?.copy(sequence = 20L, captureSequence = 8L))
    now += 1_000L
    assertNull(session.evaluate(unpaired).snapshotOrNull)
    assertEquals(retained, session.renderSnapshot, "still retained inside the timeout")
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    // Past the retention timeout the wait settles even with nothing to settle ON, and the retained
    // frame must be released so the view falls back to current inspector state.
    now += PostInputRefreshTracker.REFRESH_TIMEOUT_MS
    assertNull(session.evaluate(unpaired).snapshotOrNull)
    assertEquals(PostInputRefreshState.Settled, session.refreshState)
    assertNull(session.renderSnapshot, "the retained snapshot is released on timeout")
    assertNull(session.interactionSnapshot, "and it is no longer clickable")
    scope.cancel()
  }

  @Test
  fun `the retained snapshot stays clickable while a refresh is awaiting`() = runTest {
    // Finding 4: after a successful tap, an ordinary screenshot-only update makes the live decision
    // Blocked (nothing pairs yet) while the coherent pre-input frame is still displayed. Deriving
    // interaction from the live decision would flip THAT frame to Inspector, so a rapid second
    // click would select an element instead of reaching the device.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    val clicked = paired(captureSequence = 7L, sourceSequence = 10L)
    assertNotNull(session.evaluate(clicked).snapshotOrNull)
    val retained = assertNotNull(session.interactionSnapshot)

    session.tap(retained, point)
    advanceUntilIdle()
    assertEquals(1, client.inputTapCalls.size)
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    // A screenshot-only update lands: no snapshot pairs, so the live decision is Blocked.
    val unpaired =
      clicked.copy(screenshot = clicked.screenshot?.copy(sequence = 20L, captureSequence = 8L))
    assertNull(session.evaluate(unpaired).snapshotOrNull)

    // The frame on screen is still the retained one, and it is still what a click acts through.
    assertEquals(retained, session.renderSnapshot)
    val secondClickTarget = assertNotNull(session.interactionSnapshot)
    assertEquals(retained, secondClickTarget)

    session.tap(secondClickTarget, point)
    advanceUntilIdle()
    assertEquals(2, client.inputTapCalls.size, "a second click still reaches the device")
    scope.cancel()
  }

  @Test
  fun `a reset drops the retained frame from interaction immediately`() = runTest {
    // The retention must stay subject to the existing gates: a reset drops to Inspector at once.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val session = session(scope, FakeAutoMobileClient())

    val clicked = paired(captureSequence = 7L, sourceSequence = 10L)
    session.evaluate(clicked)
    session.tap(assertNotNull(session.interactionSnapshot), point)
    advanceUntilIdle()

    session.reset()
    assertNull(session.interactionSnapshot, "reset drops control to Inspector")
    assertNull(session.renderSnapshot)
    scope.cancel()
  }

  @Test
  fun `retention does not outlive freshness`() = runTest {
    // Finding 1: tap a frame that is already near the freshness bound, then evaluate 200ms later.
    // The live decision correctly rejects it as stale, but the 3s refresh wait is still running —
    // and since every successful tap restarts that wait, keeping the frame clickable here would let
    // stale content stay actionable indefinitely.
    var now = 100_000L
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session =
      DeviceControlSession(
        scope = scope,
        clientProvider = { client },
        platform = { "android" },
        nowMs = { now },
        publishError = {},
        uiContext = UnconfinedTestDispatcher(testScheduler),
        ioDispatcher = UnconfinedTestDispatcher(testScheduler),
      )

    // A frame received 4.9s ago: still inside the 5s screenshot bound, so control is available.
    val receivedAtMs = now - 4_900L
    val nearlyStale =
      paired(captureSequence = 7L, sourceSequence = 10L, receivedAtMs = receivedAtMs)
    assertNotNull(session.evaluate(nearlyStale).snapshotOrNull)
    val retained = assertNotNull(session.interactionSnapshot)

    session.tap(retained, point)
    advanceUntilIdle()
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    // 200ms later nothing new has arrived, so the frame is now 5.1s old. The refresh wait has 2.8s
    // left to run, but the frame must stop being clickable the moment it stops being fresh.
    now += 200L
    val decision = session.evaluate(nearlyStale)
    assertEquals(
      DeviceControlBlockReason.StaleFrame,
      (decision as DeviceControlDecision.Blocked).reason,
    )
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)
    assertNull(session.interactionSnapshot, "a stale retained frame must drop to Inspector")
    scope.cancel()
  }

  @Test
  fun `rotation mismatch drops retained interaction while awaiting refresh`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    val clicked = paired(captureSequence = 7L, sourceSequence = 10L)
    assertNotNull(session.evaluate(clicked).snapshotOrNull)
    val retained = assertNotNull(session.interactionSnapshot)

    session.tap(retained, point)
    advanceUntilIdle()
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    // The retained screenshot remains useful for display, but a new hierarchy from a different
    // rotation makes its coordinate bounds unsafe for another gesture.
    val mismatchedRotation =
      clicked.copy(hierarchy = clicked.hierarchy?.copy(sequence = 11L, rotation = 1))
    val decision = session.evaluate(mismatchedRotation)
    assertEquals(
      DeviceControlBlockReason.RotationMismatch,
      (decision as DeviceControlDecision.Blocked).reason,
    )
    assertEquals(retained, session.renderSnapshot, "the old frame can remain visible")
    assertNull(session.interactionSnapshot, "a rotation mismatch must drop to Inspector")
    scope.cancel()
  }

  /** A coherent, freshly-received screenshot+hierarchy pair sharing one capture identity. */
  private fun paired(
    captureSequence: Long,
    sourceSequence: Long,
    width: Int = 1080,
    height: Int = 2340,
    data: ByteArray? = null,
    receivedAtMs: Long = 1_000L,
  ) =
    DeviceControlInputs(
      enabled = true,
      realDeviceMode = true,
      selectedDeviceId = "emulator-5554",
      transportSupportsInput = true,
      observationStreamConnected = true,
      screenshot =
        ScreenshotFrameFacts(
          deviceId = "emulator-5554",
          sequence = sourceSequence,
          captureSequence = captureSequence,
          receivedAtMs = receivedAtMs,
          width = width,
          height = height,
          data = data,
          rotation = 0,
        ),
      hierarchy =
        HierarchyFrameFacts(
          deviceId = "emulator-5554",
          sequence = sourceSequence,
          captureSequence = captureSequence,
          receivedAtMs = receivedAtMs,
          hierarchy = null,
          rootWidth = width,
          rootHeight = height,
          rotation = 0,
        ),
      liveFrame = null,
    )
}
