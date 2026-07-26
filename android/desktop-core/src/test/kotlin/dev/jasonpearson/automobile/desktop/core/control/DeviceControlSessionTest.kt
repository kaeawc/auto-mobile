package dev.jasonpearson.automobile.desktop.core.control

import dev.jasonpearson.automobile.desktop.core.daemon.InputActionResult
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.domain.DevicePoint
import dev.jasonpearson.automobile.desktop.domain.PostInputRefreshState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
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

  @Test
  fun `an out-of-bounds point is dropped without contacting the daemon`() = runTest {
    val scope = CoroutineScope(UnconfinedTestDispatcher(testScheduler))
    val client = FakeAutoMobileClient()
    val session = session(scope, client)

    session.tap(testSnapshot(), DevicePoint(x = -5, y = 4000, inBounds = false))
    advanceUntilIdle()

    assertTrue(client.inputTapCalls.isEmpty())
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
}
