package dev.jasonpearson.automobile.desktop.core.control

import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateObserver
import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorMockData
import dev.jasonpearson.automobile.desktop.core.layout.LayoutInspectorState
import dev.jasonpearson.automobile.desktop.core.layout.buildParsedHierarchy
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.CoordinateSpace
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
import kotlinx.coroutines.test.TestCoroutineScheduler
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
    assertEquals("epoch:5", call.frameContext)
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
  fun `a stale frame-context rejection preserves rendering but blocks retry until context changes`() =
    runTest {
      val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
      val client =
        FakeAutoMobileClient().apply {
          inputTapResult =
            InputActionResult(
              action = "input/tap",
              success = false,
              error = "Stale frame context for input/tap; observe a fresh frame before retrying",
            )
        }
      val session = session(scope, client)
      val initial = paired(captureSequence = 7L, sourceSequence = 10L)
      val rejected = assertNotNull(session.evaluate(initial).snapshotOrNull)

      session.tap(rejected, point)
      advanceUntilIdle()
      session.evaluate(initial)

      assertEquals(rejected, session.renderSnapshot)
      assertNull(session.interactionSnapshot)
      assertFalse(
        session.tap(rejected, point),
        "the rejected snapshot must not retry automatically",
      )

      val delayedSameContext =
        paired(captureSequence = 8L, sourceSequence = 12L, frameContext = rejected.frameContext)
      assertNotNull(session.evaluate(delayedSameContext).snapshotOrNull)
      assertNull(
        session.interactionSnapshot,
        "a later capture under the rejected context must not restore control",
      )

      val fresh = paired(captureSequence = 9L, sourceSequence = 13L)
      val freshSnapshot = assertNotNull(session.evaluate(fresh).snapshotOrNull)

      assertEquals(freshSnapshot, session.interactionSnapshot)
      scope.cancel()
    }

  @Test
  fun `a stale frame-context rejection drops queued retries and publishes its error`() = runTest {
    val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
    val client =
      FakeAutoMobileClient().apply {
        inputTapResult =
          InputActionResult(
            action = "input/tap",
            success = false,
            error =
              "input/tap frameContext is stale or unavailable; observe a fresh frame before retrying",
          )
      }
    val published = mutableListOf<String?>()
    val session =
      DeviceControlSession(
        scope = scope,
        clientProvider = { client },
        platform = { "android" },
        nowMs = { 1_000L },
        publishError = { published += it },
        uiContext = StandardTestDispatcher(testScheduler),
        ioDispatcher = StandardTestDispatcher(testScheduler),
      )
    val snapshot = testSnapshot(sequence = 7L)

    session.tap(snapshot, point)
    session.tap(snapshot, point)
    advanceUntilIdle()

    assertEquals(
      1,
      client.inputTapCalls.size,
      "the queued gesture must not retry stale coordinates",
    )
    assertEquals(
      "input/tap frameContext is stale or unavailable; observe a fresh frame before retrying",
      published.last(),
      "the discarded retry cannot suppress the rejection that removed it",
    )
    assertNull(session.interactionSnapshot)
    scope.cancel()
  }

  @Test
  fun `a stale rejection preserves a queued input from a newer paired frame`() = runTest {
    val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
    val staleClient =
      FakeAutoMobileClient().apply {
        inputTapResult =
          InputActionResult(
            action = "input/tap",
            success = false,
            error =
              "input/tap frameContext is stale or unavailable; observe a fresh frame before retrying",
          )
      }
    val freshClient = FakeAutoMobileClient()
    val clients = listOf(staleClient, freshClient)
    var clientIndex = 0
    val session =
      DeviceControlSession(
        scope = scope,
        clientProvider = { clients[clientIndex++] },
        platform = { "android" },
        nowMs = { 1_000L },
        publishError = {},
        uiContext = StandardTestDispatcher(testScheduler),
        ioDispatcher = StandardTestDispatcher(testScheduler),
      )
    val staleSnapshot =
      assertNotNull(
        session.evaluate(paired(captureSequence = 7L, sourceSequence = 10L)).snapshotOrNull
      )
    assertTrue(session.tap(staleSnapshot, point))
    val freshSnapshot =
      assertNotNull(
        session.evaluate(paired(captureSequence = 8L, sourceSequence = 12L)).snapshotOrNull
      )

    assertTrue(session.tap(freshSnapshot, point))
    advanceUntilIdle()

    assertEquals(1, staleClient.inputTapCalls.size)
    assertEquals(1, freshClient.inputTapCalls.size, "newer-frame input must survive stale cleanup")
    assertEquals(freshSnapshot, session.interactionSnapshot)
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
      // An ignored drag changed nothing on the device, so it must neither start a refresh wait
      // nor
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
              rotation = 0,
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
  fun `a coordinate-space flip retires the retained frame before it can be tapped again`() =
    runTest {
      // Issue #4550. The daemon converts an incoming input coordinate using the runner's CURRENT
      // scale metadata, not the frame's. Retention deliberately keeps the clicked frame clickable
      // while its sources move on — so if iOS scale metadata appears (or a downgrade removes it)
      // during that window, a coordinate mapped in one space would be converted as the other and
      // land in the wrong physical place. The retained frame must stop being actionable instead.
      val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
      val client = FakeAutoMobileClient()
      val session = session(scope, client)

      // Clicked while the device was still publishing legacy point-space frames.
      val legacy = paired(captureSequence = 7L, sourceSequence = 10L, coordinateSpace = null)
      assertNotNull(session.evaluate(legacy).snapshotOrNull)
      val retained = assertNotNull(session.interactionSnapshot)
      assertNull(retained.coordinateSpace, "the clicked frame's space is bound to the snapshot")

      session.tap(retained, point)
      advanceUntilIdle()
      assertEquals(1, client.inputTapCalls.size)
      assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

      // A hierarchy arrives declaring canonical pixels — the runner now reports scale metadata.
      // Nothing pairs yet, so the live decision is Blocked and the retained frame is still on
      // screen; without the guard it would also still be clickable.
      val flipped =
        legacy.copy(
          hierarchy =
            legacy.hierarchy?.copy(
              sequence = 20L,
              captureSequence = 8L,
              coordinateSpace = CoordinateSpace.Pixels,
            )
        )
      assertNull(session.evaluate(flipped).snapshotOrNull)

      assertNull(session.renderSnapshot, "a space flip is a context invalidation, like a reset")
      assertNull(
        session.interactionSnapshot,
        "a frame mapped in the old space must not be dispatched under the new one",
      )
      scope.cancel()
    }

  @Test
  fun `a screenshot-only space flip retires the retained frame just as a hierarchy flip does`() =
    runTest {
      // The two sources are gated independently, so each needs its own coverage: a regression
      // that
      // stopped checking the SCREENSHOT's declaration would still pass the hierarchy-flip test.
      val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
      val session = session(scope, FakeAutoMobileClient())

      val legacy = paired(captureSequence = 7L, sourceSequence = 10L, coordinateSpace = null)
      assertNotNull(session.evaluate(legacy).snapshotOrNull)
      val retained = assertNotNull(session.interactionSnapshot)
      session.tap(retained, point)
      advanceUntilIdle()
      assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

      // Only the screenshot flips this time.
      val flipped =
        legacy.copy(
          screenshot =
            legacy.screenshot?.copy(
              sequence = 20L,
              captureSequence = 8L,
              coordinateSpace = CoordinateSpace.Pixels,
            )
        )
      assertNull(session.evaluate(flipped).snapshotOrNull)

      assertNull(session.renderSnapshot, "a space flip is a context invalidation, like a reset")
      assertNull(
        session.interactionSnapshot,
        "a screenshot-space flip must retire the retained frame too",
      )
      scope.cancel()
    }

  @Test
  fun `a coordinate-space flip purges commands already queued for dispatch`() = runTest {
    // Clearing the retained snapshot stops FUTURE clicks, but a command already accepted into the
    // bounded FIFO is untouched by that. With a stalled daemon request ahead of it, a queued tap
    // would be forwarded after the flip and converted by the daemon under the NEW scale metadata —
    // actuating the wrong physical location. The flip must drain the queue, like every other
    // control-context invalidation.
    //
    // StandardTestDispatcher (not Unconfined) so the single consumer is dispatched but has not run
    // when the tap is enqueued — exactly the state a consumer blocked on a stalled daemon is in.
    val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
    val clients = mutableListOf<FakeAutoMobileClient>()
    val session =
      DeviceControlSession(
        scope = scope,
        clientProvider = { FakeAutoMobileClient().also { clients.add(it) } },
        platform = { "android" },
        nowMs = { 1_000L },
        publishError = {},
        uiContext = StandardTestDispatcher(testScheduler),
        ioDispatcher = StandardTestDispatcher(testScheduler),
      )

    val legacy = paired(captureSequence = 7L, sourceSequence = 10L, coordinateSpace = null)
    assertNotNull(session.evaluate(legacy).snapshotOrNull)
    assertTrue(session.tap(assertNotNull(session.interactionSnapshot), point))
    assertEquals(1, clients.size, "the tap is queued, with its client captured")

    // The space flips while that tap is still sitting in the queue.
    val flipped =
      legacy.copy(
        hierarchy =
          legacy.hierarchy?.copy(
            sequence = 20L,
            captureSequence = 8L,
            coordinateSpace = CoordinateSpace.Pixels,
          )
      )
    session.evaluate(flipped)
    advanceUntilIdle()

    val queued = clients.single()
    assertTrue(
      queued.inputTapCalls.isEmpty(),
      "a tap mapped in the old space must never reach the device after the flip",
    )
    assertTrue("close" in queued.calls, "and its captured client must be closed")
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `a flip is caught at stream receipt, inside the hierarchy debounce window`() = runTest {
    // The window the fact-level check cannot cover. LayoutInspectorState debounces hierarchy
    // updates by ~100ms, so a `hierarchy_update` declaring the new space does not reach the frame
    // facts — and therefore does not reach evaluate() — until that timer fires. The daemon,
    // meanwhile, switched to converting input under the new scale metadata the moment it published.
    // A tap inside that window would be mapped in the old unit and converted as the new one.
    //
    // This drives the REAL debounced path (a TestDispatcher-backed LayoutInspectorState) rather
    // than calling applyHierarchyUpdateImmediate, so the window actually exists in the test.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val state = LayoutInspectorState(StandardTestDispatcher(testScheduler))

    // Control is live on a legacy point-space frame.
    val legacy = paired(captureSequence = 7L, sourceSequence = 10L, coordinateSpace = null)
    session.onObservationSpaceDeclared(null, captureSequence = 7L)
    assertNotNull(session.evaluate(legacy).snapshotOrNull)
    val clicked = assertNotNull(session.interactionSnapshot)

    // A hierarchy_update arrives declaring canonical pixels. The collector notes the space at
    // RECEIPT and hands the parsed tree to the debounced apply.
    session.onObservationSpaceDeclared(
      CoordinateSpace.Pixels,
      captureSequence = 8L,
      nativeScale = 1.0,
    )
    state.applyHierarchyUpdate(
      buildParsedHierarchy(LayoutInspectorMockData.mockHierarchy),
      emptySet(),
      deviceId = "emulator-5554",
      captureSequence = 8L,
      coordinateSpace = CoordinateSpace.Pixels,
    )

    // INSIDE the debounce window. The facts still hold the OLD declaration — evaluate() has nothing
    // new to see — yet control must already be dead, because there is no snapshot for the view to
    // map a click through.
    assertNull(state.hierarchyFacts?.coordinateSpace, "the debounce has not fired yet")
    assertNull(
      session.interactionSnapshot,
      "receipt-time detection must retire control before the debounce fires",
    )
    assertNull(session.renderSnapshot)
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    assertNotNull(clicked, "the pre-flip frame existed, so this is a retirement and not a no-frame")

    // And the window was real: the debounce only now delivers the new declaration to the facts,
    // which is where a fact-level check would first have noticed.
    advanceUntilIdle()
    assertEquals(CoordinateSpace.Pixels, state.hierarchyFacts?.coordinateSpace)
    assertTrue(client.inputTapCalls.isEmpty(), "nothing reached the device")
    scope.cancel()
  }

  @Test
  fun `a frame-context change retires control at stream receipt`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val current = paired(captureSequence = 7L, sourceSequence = 10L)

    session.onObservationFrameContextDeclared("epoch:7", captureSequence = 7L)
    assertNotNull(session.evaluate(current).snapshotOrNull)
    val clickedBeforeChange = assertNotNull(session.interactionSnapshot)

    // The new context has arrived, but the hierarchy/screenshot facts may still be awaiting their
    // asynchronous application. This receipt-time hook closes that interval.
    session.onObservationFrameContextDeclared("epoch:8", captureSequence = 8L)

    // The old paired facts are still available, but evaluating them must not restore the snapshot
    // that receipt-time invalidation just retired.
    assertNotNull(session.evaluate(current).snapshotOrNull)
    assertNull(session.interactionSnapshot)
    assertFalse(session.tap(clickedBeforeChange, point))
    advanceUntilIdle()
    assertTrue(client.inputTapCalls.isEmpty())
    scope.cancel()
  }

  @Test
  fun `the receipt-time retirement invalidates Compose readers of the interaction snapshot`() =
    runTest {
      // Half (a) of the receipt fix. Retiring the snapshot early is only useful if the VIEW
      // notices:
      // the hook fires from a stream collector with no other state change to ride on, so with a
      // plain (non-snapshot) field DeviceScreenView would keep its stale controlFrame — and keep
      // mapping clicks through it — until the next recomposition, which for the hierarchy path is
      // the ~100ms debounce. Composing the real view here would need the whole host graph, so
      // this
      // asserts the property the view depends on: a Compose reader of interactionSnapshot is
      // invalidated by the retirement.
      val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
      val session = session(scope, FakeAutoMobileClient())

      session.onObservationSpaceDeclared(null, captureSequence = 7L)
      assertNotNull(
        session.evaluate(paired(captureSequence = 7L, sourceSequence = 10L)).snapshotOrNull
      )
      assertNotNull(session.interactionSnapshot)

      val observer = SnapshotStateObserver { block -> block() }
      observer.start()
      try {
        var invalidated = false
        // Records exactly what the view records: a read of the snapshot control maps clicks
        // through.
        observer.observeReads("view", { invalidated = true }) { session.interactionSnapshot }
        Snapshot.sendApplyNotifications()
        assertFalse(invalidated, "no write yet")

        session.onObservationSpaceDeclared(
          CoordinateSpace.Pixels,
          captureSequence = 8L,
          nativeScale = 1.0,
        )
        Snapshot.sendApplyNotifications()

        assertTrue(
          invalidated,
          "retiring the frame must invalidate the view's read, or the stale controlFrame survives " +
            "until the debounce fires",
        )
        assertNull(session.interactionSnapshot)
      } finally {
        observer.stop()
        observer.clear()
      }
      scope.cancel()
    }

  @Test
  fun `a late screenshot bound to an older capture cannot roll the tracked space backward`() =
    runTest {
      // #4549 binds a screenshot's coordinate space when its capture is REQUESTED, so a
      // mid-flight
      // metadata change cannot relabel the frame. The consequence here: a screenshot can arrive
      // AFTER a newer hierarchy while still carrying the OLDER declaration. Observing it
      // unconditionally would roll the session's notion of "current" back to a space the device
      // has
      // already left — this hook fighting the binding that makes the frame trustworthy — and the
      // dispatch gate would then accept old-space snapshots and reject new-space ones.
      val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
      val client = FakeAutoMobileClient()
      val session = session(scope, client)

      // Capture 7 is legacy; capture 8's hierarchy declares canonical pixels.
      session.onObservationSpaceDeclared(null, captureSequence = 7L)
      session.onObservationSpaceDeclared(
        CoordinateSpace.Pixels,
        captureSequence = 8L,
        nativeScale = 1.0,
      )

      // The capture-7 screenshot finally lands, still carrying its request-time legacy binding.
      session.onObservationSpaceDeclared(null, captureSequence = 7L)

      // The session must still consider PIXELS current: a px frame dispatches, a legacy one does
      // not. If the stale observation had been recorded, both answers would be inverted.
      assertTrue(
        session.tap(testSnapshot(coordinateSpace = CoordinateSpace.Pixels), point),
        "the newer declared space must still be the current one",
      )
      advanceUntilIdle()
      assertEquals(1, client.inputTapCalls.size)

      assertFalse(
        session.tap(testSnapshot(coordinateSpace = null), point),
        "the space the device already left must not be resurrected by a late frame",
      )
      advanceUntilIdle()
      assertEquals(1, client.inputTapCalls.size, "nothing further reached the device")

      // And an IN-ORDER observation still advances the tracker, so this is an ordering guard and
      // not a freeze: capture 9 goes back to legacy and legacy becomes dispatchable again.
      session.onObservationSpaceDeclared(null, captureSequence = 9L)
      assertTrue(session.tap(testSnapshot(coordinateSpace = null), point))
      advanceUntilIdle()
      assertEquals(2, client.inputTapCalls.size)
      scope.cancel()
    }

  @Test
  fun `an unsequenced screenshot cannot roll back a sequenced coordinate space`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    session.onObservationSpaceDeclared(
      CoordinateSpace.Pixels,
      captureSequence = 8L,
      nativeScale = 1.0,
    )

    // A screenshot whose declared dimensions do not match its PNG keeps this old binding but has
    // its capture identity stripped before delivery. It cannot prove that the current stream space
    // changed after the sequenced observation.
    session.onObservationSpaceDeclared(null, captureSequence = null)

    assertTrue(
      session.tap(testSnapshot(coordinateSpace = CoordinateSpace.Pixels), point),
      "the sequenced coordinate space remains current",
    )
    advanceUntilIdle()
    assertFalse(
      session.tap(testSnapshot(coordinateSpace = null), point),
      "an unsequenced legacy declaration cannot resurrect the old space",
    )
    advanceUntilIdle()
    assertEquals(1, client.inputTapCalls.size, "only the pixel-space tap reached the device")
    scope.cancel()
  }

  @Test
  fun `an unsequenced rollback cannot dispatch a pointer captured before a space flip`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    session.onObservationSpaceDeclared(null, captureSequence = 7L)
    assertNotNull(
      session.evaluate(paired(captureSequence = 7L, sourceSequence = 10L)).snapshotOrNull
    )
    val clickedBeforeFlip = assertNotNull(session.interactionSnapshot)

    session.onObservationSpaceDeclared(
      CoordinateSpace.Pixels,
      captureSequence = 8L,
      nativeScale = 1.0,
    )
    session.onObservationSpaceDeclared(null, captureSequence = null)

    assertFalse(
      session.tap(clickedBeforeFlip, point),
      "a pre-flip legacy pointer must stay rejected after an unsequenced old-space screenshot",
    )
    advanceUntilIdle()
    assertTrue(client.inputTapCalls.isEmpty(), "nothing reached the device")
    scope.cancel()
  }

  @Test
  fun `unsequenced-only sessions retain coordinate-space tracking`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    session.onObservationSpaceDeclared(null, captureSequence = null)
    assertTrue(session.tap(testSnapshot(coordinateSpace = null), point))
    advanceUntilIdle()

    // Legacy runners never provide a capture sequence, so their later declaration must still
    // advance the stream space and retire the previous coordinate unit.
    session.onObservationSpaceDeclared(
      CoordinateSpace.Pixels,
      captureSequence = null,
      nativeScale = 1.0,
    )
    assertTrue(session.tap(testSnapshot(coordinateSpace = CoordinateSpace.Pixels), point))
    assertFalse(session.tap(testSnapshot(coordinateSpace = null), point))
    advanceUntilIdle()

    assertEquals(2, client.inputTapCalls.size)
    scope.cancel()
  }

  @Test
  fun `a tap or swipe carrying a retired snapshot is rejected at dispatch`() = runTest {
    // Half (b): defence in depth. Even with the observable retirement, a pointer event that
    // CAPTURED the snapshot before the flip can reach dispatch after it — the view cannot
    // un-capture it. Dispatch is the last place to catch a coordinate in the wrong unit, and
    // `inBounds` alone says nothing about units.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    session.onObservationSpaceDeclared(null, captureSequence = 7L)
    assertNotNull(
      session.evaluate(paired(captureSequence = 7L, sourceSequence = 10L)).snapshotOrNull
    )
    val clickedBeforeFlip = assertNotNull(session.interactionSnapshot)

    // The device starts publishing canonical pixels; the in-flight click still carries the legacy
    // frame it was mapped through.
    session.onObservationSpaceDeclared(
      CoordinateSpace.Pixels,
      captureSequence = 8L,
      nativeScale = 1.0,
    )

    assertFalse(
      session.tap(clickedBeforeFlip, point),
      "a tap mapped in the retired space must not be queued",
    )
    assertFalse(
      session.swipe(
        clickedBeforeFlip,
        DevicePoint(100, 100, inBounds = true),
        DevicePoint(100, 400, inBounds = true),
      ),
      "and neither must a swipe",
    )
    advanceUntilIdle()
    assertTrue(client.inputTapCalls.isEmpty(), "nothing reached the device")
    assertTrue(client.inputSwipeCalls.isEmpty())

    // A frame in the CURRENT space still dispatches, so this is a units gate and not a freeze.
    val current = testSnapshot(coordinateSpace = CoordinateSpace.Pixels)
    assertTrue(session.tap(current, point))
    advanceUntilIdle()
    assertEquals(1, client.inputTapCalls.size)
    scope.cancel()
  }

  @Test
  fun `a flip into an unrecognized space retires the retained frame`() = runTest {
    // The reason absent and declared-but-unknown must be different values: collapsed to one, this
    // transition would compare equal to the retained legacy frame and pass unnoticed, leaving a
    // frame clickable against a daemon whose input unit this client cannot know.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val session = session(scope, FakeAutoMobileClient())

    val legacy = paired(captureSequence = 7L, sourceSequence = 10L, coordinateSpace = null)
    assertNotNull(session.evaluate(legacy).snapshotOrNull)
    val retained = assertNotNull(session.interactionSnapshot)
    session.tap(retained, point)
    advanceUntilIdle()

    val flipped =
      legacy.copy(
        hierarchy =
          legacy.hierarchy?.copy(
            sequence = 20L,
            captureSequence = 8L,
            coordinateSpace = CoordinateSpace.Unrecognized("pt"),
          )
      )
    assertNull(session.evaluate(flipped).snapshotOrNull)
    assertNull(
      session.interactionSnapshot,
      "legacy -> unrecognized is a transition, not a no-op",
    )
    scope.cancel()
  }

  @Test
  fun `the swipe threshold follows the clicked frame's coordinate space`() = runTest {
    // The threshold is a PHYSICAL distance, so canonical pixels changed its numeric value. A
    // 24-unit
    // drag is a swipe in the legacy point space and is NOT one on a px frame, where 24 physical
    // pixels reaches a 3x iOS runner as 8 logical points — below its own touch slop.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    val start = DevicePoint(100, 100, inBounds = true)
    val short = DevicePoint(124, 100, inBounds = true) // 24 units
    val long = DevicePoint(172, 100, inBounds = true) // 72 units

    val px = testSnapshot(coordinateSpace = CoordinateSpace.Pixels, nativeScale = 3.0)
    assertFalse(session.swipe(px, start, short), "24px is below the canonical-pixel threshold")
    advanceUntilIdle()
    assertTrue(client.inputSwipeCalls.isEmpty(), "and nothing reached the device")

    assertTrue(session.swipe(px, start, long), "72px clears it")
    advanceUntilIdle()
    assertEquals(1, client.inputSwipeCalls.size)

    // The legacy path keeps its 24-unit behavior exactly.
    val legacy = testSnapshot(coordinateSpace = null)
    assertTrue(session.swipe(legacy, start, short), "24 units is still a swipe in point space")
    advanceUntilIdle()
    assertEquals(2, client.inputSwipeCalls.size)
    scope.cancel()
  }

  @Test
  fun `retention survives source updates that keep the same coordinate space`() = runTest {
    // The guard must fire on a TRANSITION, not on every update: a screenshot-only update in the
    // same declared space is the ordinary post-input case and must keep the frame clickable.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    val px =
      paired(captureSequence = 7L, sourceSequence = 10L, coordinateSpace = CoordinateSpace.Pixels)
    assertNotNull(session.evaluate(px).snapshotOrNull)
    val retained = assertNotNull(session.interactionSnapshot)
    assertEquals(CoordinateSpace.Pixels, retained.coordinateSpace)

    session.tap(retained, point)
    advanceUntilIdle()

    val sameSpace = px.copy(screenshot = px.screenshot?.copy(sequence = 20L, captureSequence = 8L))
    assertNull(session.evaluate(sameSpace).snapshotOrNull)

    assertEquals(retained, session.interactionSnapshot, "still clickable in the same space")
    session.tap(assertNotNull(session.interactionSnapshot), point)
    advanceUntilIdle()
    assertEquals(2, client.inputTapCalls.size)
    scope.cancel()
  }

  @Test
  fun `a native-scale transition retires the retained pixel snapshot`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val pixelFrame =
      paired(
        captureSequence = 7L,
        sourceSequence = 10L,
        coordinateSpace = CoordinateSpace.Pixels,
        nativeScale = 3.0,
      )

    session.onObservationSpaceDeclared(
      CoordinateSpace.Pixels,
      captureSequence = 7L,
      nativeScale = 3.0,
    )
    assertNotNull(session.evaluate(pixelFrame).snapshotOrNull)
    val retained = assertNotNull(session.interactionSnapshot)

    session.tap(retained, point)
    advanceUntilIdle()
    session.onObservationSpaceDeclared(
      CoordinateSpace.Pixels,
      captureSequence = 8L,
      nativeScale = 3.5,
    )

    assertNull(session.interactionSnapshot, "a scale transition changes the input conversion")
    assertFalse(session.tap(retained, point), "the retained frame uses the retired scale")
    advanceUntilIdle()
    assertEquals(1, client.inputTapCalls.size)
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
    // rotation and capture makes its coordinate bounds unsafe for another gesture. Platform
    // clients publish this hierarchy before beginning the next screenshot capture.
    val mismatchedRotation =
      clicked.copy(
        hierarchy = clicked.hierarchy?.copy(sequence = 11L, captureSequence = 8L, rotation = 1)
      )
    val decision = session.evaluate(mismatchedRotation)
    assertEquals(
      DeviceControlBlockReason.RotationMismatch,
      (decision as DeviceControlDecision.Blocked).reason,
    )
    assertEquals(retained, session.renderSnapshot, "the old frame can remain visible")
    assertNull(session.interactionSnapshot, "a rotation mismatch must drop to Inspector")
    scope.cancel()
  }

  @Test
  fun `a proven unpaired rotation drops retained interaction while awaiting refresh`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val session = session(scope, FakeAutoMobileClient())

    val clicked = paired(captureSequence = 7L, sourceSequence = 10L)
    assertNotNull(session.evaluate(clicked).snapshotOrNull)
    val retained = assertNotNull(session.interactionSnapshot)

    session.tap(retained, point)
    advanceUntilIdle()
    assertEquals(PostInputRefreshState.AwaitingSnapshot, session.refreshState)

    // Both new sources prove landscape, but neither has a capture identity yet. The policy cannot
    // assemble them, so this is deliberately not RotationMismatch; it must nevertheless retire
    // the portrait mapping before a second click can be sent through stale bounds.
    val incomingLandscape =
      clicked.copy(
        screenshot = clicked.screenshot?.copy(sequence = 11L, captureSequence = null, rotation = 1),
        hierarchy = clicked.hierarchy?.copy(sequence = 12L, captureSequence = null, rotation = 1),
      )
    val decision = session.evaluate(incomingLandscape)
    assertEquals(
      DeviceControlBlockReason.CaptureIdentityUnavailable,
      (decision as DeviceControlDecision.Blocked).reason,
    )
    assertEquals(retained, session.renderSnapshot, "the old frame can remain visible")
    assertNull(session.interactionSnapshot, "a proven incoming rotation must drop to Inspector")
    scope.cancel()
  }

  @Test
  fun `a screenshot-first rotation with a stale hierarchy blocks dispatch`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val base = paired(captureSequence = 8L, sourceSequence = 11L)
    val conflictingRotations = base.copy(screenshot = base.screenshot?.copy(rotation = 1))

    session.evaluate(conflictingRotations)

    assertFalse(
      session.tap(testSnapshot().copy(rotation = 0), point),
      "the stale hierarchy cannot make the disagreement dispatchable",
    )
    advanceUntilIdle()
    assertTrue(client.inputTapCalls.isEmpty(), "nothing reaches the device during disagreement")
    scope.cancel()
  }

  @Test
  fun `a hierarchy-first rotation with a stale screenshot blocks dispatch`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val base = paired(captureSequence = 8L, sourceSequence = 11L)
    val conflictingRotations = base.copy(hierarchy = base.hierarchy?.copy(rotation = 1))

    session.evaluate(conflictingRotations)

    assertFalse(
      session.tap(testSnapshot().copy(rotation = 1), point),
      "the newer hierarchy cannot make the disagreement dispatchable",
    )
    advanceUntilIdle()
    assertTrue(client.inputTapCalls.isEmpty(), "nothing reaches the device during disagreement")
    scope.cancel()
  }

  @Test
  fun `a pointer captured before a rotation disagreement is not dispatched`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val initial = paired(captureSequence = 7L, sourceSequence = 10L)
    val clicked = assertNotNull(session.evaluate(initial).snapshotOrNull)
    val conflictingRotations =
      initial.copy(screenshot = initial.screenshot?.copy(sequence = 11L, rotation = 1))

    session.evaluate(conflictingRotations)

    assertFalse(session.tap(clicked, point), "the in-flight pointer must fail closed")
    advanceUntilIdle()
    assertTrue(client.inputTapCalls.isEmpty(), "the captured pointer never reaches the device")
    scope.cancel()
  }

  @Test
  fun `queued coordinate commands are discarded after a rotation disagreement`() = runTest {
    val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
    val clients = mutableListOf<FakeAutoMobileClient>()
    val session =
      DeviceControlSession(
        scope = scope,
        clientProvider = { FakeAutoMobileClient().also { clients += it } },
        platform = { "android" },
        nowMs = { 1_000L },
        publishError = {},
        uiContext = StandardTestDispatcher(testScheduler),
        ioDispatcher = StandardTestDispatcher(testScheduler),
      )
    val initial = paired(captureSequence = 7L, sourceSequence = 10L)
    val snapshot = assertNotNull(session.evaluate(initial).snapshotOrNull)

    assertTrue(session.tap(snapshot, point))
    assertTrue(
      session.swipe(
        snapshot,
        DevicePoint(x = 540, y = 1800, inBounds = true),
        DevicePoint(x = 540, y = 400, inBounds = true),
      )
    )
    assertEquals(2, clients.size, "each queued command captures its client")

    session.evaluate(
      initial.copy(screenshot = initial.screenshot?.copy(sequence = 11L, rotation = 1))
    )
    advanceUntilIdle()

    clients.forEach { client ->
      assertTrue(client.inputTapCalls.isEmpty(), "a queued tap cannot survive disagreement")
      assertTrue(client.inputSwipeCalls.isEmpty(), "a queued swipe cannot survive disagreement")
      assertTrue("close" in client.calls, "a discarded command closes its captured client")
    }
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `an unproven update cannot clear a rotation disagreement`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val initial = paired(captureSequence = 7L, sourceSequence = 10L)
    val snapshot = assertNotNull(session.evaluate(initial).snapshotOrNull)
    val disagreement =
      initial.copy(screenshot = initial.screenshot?.copy(sequence = 11L, rotation = 1))

    session.evaluate(disagreement)
    val unproven =
      disagreement.copy(screenshot = disagreement.screenshot?.copy(sequence = 12L, rotation = null))
    assertEquals(
      DeviceControlBlockReason.RotationMismatch,
      (session.evaluate(unproven) as DeviceControlDecision.Blocked).reason,
    )

    assertFalse(
      session.tap(snapshot, point),
      "an unproven screenshot cannot prove that the earlier conflict resolved",
    )
    assertTrue(client.inputTapCalls.isEmpty())

    val agreement =
      unproven.copy(
        screenshot = unproven.screenshot?.copy(sequence = 13L, rotation = 0),
        hierarchy = unproven.hierarchy?.copy(sequence = 13L, rotation = 0),
      )
    val agreedSnapshot = assertNotNull(session.evaluate(agreement).snapshotOrNull)
    assertTrue(session.tap(agreedSnapshot, point), "valid agreement restores coordinate dispatch")
    advanceUntilIdle()
    assertEquals(1, client.inputTapCalls.size)
    scope.cancel()
  }

  @Test
  fun `coordinate commands revalidate rotations after dispatching to io`() = runTest {
    val ioScheduler = TestCoroutineScheduler()
    val scope = CoroutineScope(StandardTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session =
      DeviceControlSession(
        scope = scope,
        clientProvider = { client },
        platform = { "android" },
        nowMs = { 1_000L },
        publishError = {},
        uiContext = StandardTestDispatcher(testScheduler),
        ioDispatcher = StandardTestDispatcher(ioScheduler),
      )
    val initial = paired(captureSequence = 7L, sourceSequence = 10L)
    val snapshot = assertNotNull(session.evaluate(initial).snapshotOrNull)

    assertTrue(session.tap(snapshot, point))
    advanceUntilIdle()

    // The consumer passed its pre-IO check but is suspended before the daemon call.
    session.evaluate(
      initial.copy(screenshot = initial.screenshot?.copy(sequence = 11L, rotation = 1))
    )
    ioScheduler.advanceUntilIdle()
    advanceUntilIdle()

    assertTrue(
      client.inputTapCalls.isEmpty(),
      "the IO-boundary check must reject stale coordinates",
    )
    assertTrue("close" in client.calls, "the discarded command closes its captured client")
    assertEquals(PostInputRefreshState.Idle, session.refreshState)
    scope.cancel()
  }

  @Test
  fun `single and unanimous proven rotations remain dispatchable`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)
    val singleSourceBase = paired(captureSequence = 8L, sourceSequence = 11L)
    val singleSource =
      singleSourceBase.copy(
        screenshot = singleSourceBase.screenshot?.copy(rotation = 1),
        hierarchy = singleSourceBase.hierarchy?.copy(rotation = null),
      )

    session.evaluate(singleSource)
    assertTrue(session.tap(testSnapshot().copy(rotation = 1), point))
    advanceUntilIdle()

    val unanimousBase = paired(captureSequence = 9L, sourceSequence = 12L)
    val unanimous =
      unanimousBase.copy(
        screenshot = unanimousBase.screenshot?.copy(rotation = 2),
        hierarchy = unanimousBase.hierarchy?.copy(rotation = 2),
      )
    session.evaluate(unanimous)
    assertTrue(session.tap(testSnapshot().copy(rotation = 2), point))
    advanceUntilIdle()

    assertEquals(2, client.inputTapCalls.size)
    scope.cancel()
  }

  @Test
  fun `the live frame alone re-proves orientation after a rotation`() = runTest {
    // Issue #4786: once the video stream attests rotation, a live frame carrying the new rotation
    // re-proves orientation on its own — before the screenshot/hierarchy sources catch up — so
    // control does not stay blocked waiting for an observation refresh.
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    // Proven rotation 0 from a coherent observation pair.
    session.evaluate(paired(captureSequence = 8L, sourceSequence = 11L))
    assertTrue(session.tap(testSnapshot().copy(rotation = 0), point))
    advanceUntilIdle()

    // The device rotates to 1; only the live frame attests it (the observation sources report no
    // rotation yet).
    val liveProvesRotation = paired(captureSequence = 9L, sourceSequence = 12L)
    session.evaluate(
      liveProvesRotation.copy(
        screenshot = liveProvesRotation.screenshot?.copy(rotation = null),
        hierarchy = liveProvesRotation.hierarchy?.copy(rotation = null),
        liveFrame =
          LiveFrameFacts(
            deviceId = "emulator-5554",
            sequence = 900_000L,
            receivedAtMs = 1_000L,
            width = 1080,
            height = 2340,
            rotation = 1,
          ),
      )
    )

    // Orientation is re-proven to 1 from the live frame alone: a rotation-1 tap dispatches,
    assertTrue(session.tap(testSnapshot().copy(rotation = 1), point))
    advanceUntilIdle()
    // and the stale rotation-0 orientation is no longer dispatchable.
    assertFalse(session.tap(testSnapshot().copy(rotation = 0), point))
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
    coordinateSpace: CoordinateSpace? = null,
    nativeScale: Double? = if (coordinateSpace == CoordinateSpace.Pixels) 1.0 else null,
    frameContext: String = "epoch:$captureSequence",
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
          coordinateSpace = coordinateSpace,
          nativeScale = nativeScale,
          frameContext = frameContext,
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
          coordinateSpace = coordinateSpace,
          nativeScale = nativeScale,
          frameContext = frameContext,
          rotation = 0,
        ),
      liveFrame = null,
    )
}
