package dev.jasonpearson.automobile.ctrlproxy

import android.accessibilityservice.AccessibilityService
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.GlobalActionResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class GlobalActionControllerTest {
  /** Each read advances 10 ms, so the dispatch time is visible in the result. */
  private class SteppingTimer : TimeProvider {
    private var now = 2_000L

    override fun currentTimeMillis(): Long = now.also { now += 10L }
  }

  /**
   * An accessibility service that dispatches every action it is given unless [dispatches] is false,
   * remembers an insert caret until told to forget it, and records what it broadcasts. The order of
   * calls is kept so the caret reset can be checked against the dispatch.
   */
  private class FakeHost : GlobalActionController.Host {
    var dispatches = true
    var failBroadcast: RuntimeException? = null
    val calls = mutableListOf<String>()
    val results = mutableListOf<GlobalActionResult>()

    override fun performGlobalAction(actionId: Int): Boolean {
      calls += "dispatch:$actionId"
      return dispatches
    }

    override fun forgetRememberedInsert() {
      calls += "forget"
    }

    override suspend fun broadcast(result: GlobalActionResult) {
      failBroadcast?.let { throw it }
      results += result
    }
  }

  private val host = FakeHost()
  private val errors = mutableListOf<ErrorResponse>()

  private fun controller(testScope: TestScope, sdkInt: Int = 34) =
    GlobalActionController(
      host = host,
      asyncActionRunner =
        AsyncActionRunner(
          scope = CoroutineScope(UnconfinedTestDispatcher(testScope.testScheduler)),
          broadcastResponse = { errors += it as ErrorResponse },
          logError = { _, _ -> },
        ),
      timeProvider = SteppingTimer(),
      sdkInt = sdkInt,
    )

  @Test
  fun `a dispatched action reports success after forgetting the caret`() = runTest {
    controller(this).performGlobalActionRequest("req-1", "back")

    assertEquals(
      listOf("forget", "dispatch:${AccessibilityService.GLOBAL_ACTION_BACK}"),
      host.calls,
    )
    val result = host.results.single()
    assertEquals("req-1", result.requestId)
    assertEquals("back", result.action)
    assertTrue(result.success)
    assertNull(result.error)
  }

  @Test
  fun `an alias resolves to its action`() = runTest {
    controller(this).performGlobalActionRequest("req-2", "recents")

    assertEquals("dispatch:${AccessibilityService.GLOBAL_ACTION_RECENTS}", host.calls.last())
    assertTrue(host.results.single().success)
  }

  @Test
  fun `a refused dispatch reports the generic failure`() = runTest {
    host.dispatches = false

    controller(this).performGlobalActionRequest("req-3", "home")

    val result = host.results.single()
    assertEquals(false, result.success)
    assertEquals("Global action failed: home", result.error)
  }

  @Test
  fun `an action newer than the device is refused without dispatching`() = runTest {
    controller(this, sdkInt = 27).performGlobalActionRequest("req-4", "lock_screen")

    assertEquals(listOf("forget"), host.calls)
    assertEquals(
      "Global action lock_screen requires Android API 28+ (device is API 27)",
      host.results.single().error,
    )
  }

  @Test
  fun `an unknown action is refused without dispatching`() = runTest {
    controller(this).performGlobalActionRequest("req-5", "teleport")

    assertEquals(listOf("forget"), host.calls)
    assertEquals("Unsupported global action: teleport", host.results.single().error)
  }

  @Test
  fun `timing comes from the injected clock`() = runTest {
    controller(this).performGlobalActionRequest("req-6", "back")

    // Start at 2000, end at 2010, then the result timestamp reads 2020.
    val result = host.results.single()
    assertEquals(10L, result.totalTimeMs)
    assertEquals(2_020L, result.timestamp)
  }

  @Test
  fun `a failed broadcast becomes a correlated error instead of a hang`() = runTest {
    host.failBroadcast = IllegalStateException("socket closed")

    controller(this).performGlobalActionRequest("req-7", "back")

    assertEquals("req-7", errors.single().requestId)
  }
}
