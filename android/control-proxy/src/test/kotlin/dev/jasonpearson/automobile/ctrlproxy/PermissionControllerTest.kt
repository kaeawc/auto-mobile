package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.PermissionResult
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
class PermissionControllerTest {
  /** Each read advances 25 ms, so a request's total time is visible in the result. */
  private class SteppingTimer : TimeProvider {
    private var now = 1_000L

    override fun currentTimeMillis(): Long = now.also { now += 25L }
  }

  /**
   * Models an overlay permission that a request launches the settings flow for; records each lookup
   * and can throw instead.
   */
  private class FakePermissions : PermissionStateSource {
    var granted = false
    var failWith: RuntimeException? = null
    val lookups = mutableListOf<Pair<String?, Boolean>>()

    override fun permissionState(
      permission: String?,
      requestPermission: Boolean,
    ): PermissionManager.PermissionState {
      lookups += permission to requestPermission
      failWith?.let { throw it }
      if (permission == null) {
        return missing.copy(permission = "unknown", error = "Permission name is required")
      }
      if (granted) {
        return missing.copy(permission = permission, granted = true)
      }
      return missing.copy(
        permission = permission,
        requestLaunched = requestPermission,
        canRequest = true,
        requiresSettings = true,
        instructions = "Allow display over other apps",
        adbCommand = "appops set dev.app SYSTEM_ALERT_WINDOW allow",
      )
    }

    private val missing =
      PermissionManager.PermissionState(
        permission = "",
        granted = false,
        requestLaunched = false,
        canRequest = false,
        requiresSettings = false,
        error = null,
        instructions = null,
        adbCommand = null,
      )
  }

  private val permissions = FakePermissions()
  private val transport = FakeResultTransport()
  private val errors = mutableListOf<ErrorResponse>()

  private fun controller(testScope: TestScope) =
    PermissionController(
      permissions = permissions,
      asyncActionRunner =
        AsyncActionRunner(
          scope = CoroutineScope(UnconfinedTestDispatcher(testScope.testScheduler)),
          broadcastResponse = { errors += it as ErrorResponse },
          logError = { _, _ -> },
        ),
      timeProvider = SteppingTimer(),
      resultSender =
        guardedResultSender(
          transport,
          ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
        ),
    )

  private fun result(): PermissionResult = transport.sentResponses.single() as PermissionResult

  @Test
  fun `a missing request flag requests the permission and reports the launched flow`() = runTest {
    controller(this).getPermission("req-1", "draw_overlay", requestPermission = null)

    assertEquals(listOf<Pair<String?, Boolean>>("draw_overlay" to true), permissions.lookups)
    val result = result()
    assertEquals("req-1", result.requestId)
    assertTrue(result.success)
    assertEquals("draw_overlay", result.permission)
    assertEquals(false, result.granted)
    assertEquals(true, result.requestLaunched)
    assertEquals(true, result.canRequest)
    assertEquals(true, result.requiresSettings)
    assertEquals("Allow display over other apps", result.instructions)
    assertEquals("appops set dev.app SYSTEM_ALERT_WINDOW allow", result.adbCommand)
    assertNull(result.error)
  }

  @Test
  fun `an explicit false only reads the state`() = runTest {
    controller(this).getPermission("req-2", "draw_overlay", requestPermission = false)

    assertEquals(listOf<Pair<String?, Boolean>>("draw_overlay" to false), permissions.lookups)
    assertEquals(false, result().requestLaunched)
  }

  @Test
  fun `a granted permission reports granted with nothing to request`() = runTest {
    permissions.granted = true

    controller(this).getPermission("req-3", "draw_overlay", requestPermission = true)

    val result = result()
    assertEquals(true, result.granted)
    assertEquals(false, result.requestLaunched)
    assertNull(result.instructions)
  }

  @Test
  fun `a lookup error is a failed result carrying the error`() = runTest {
    controller(this).getPermission("req-4", permission = null, requestPermission = null)

    val result = result()
    assertEquals(false, result.success)
    assertEquals("Permission name is required", result.error)
  }

  @Test
  fun `total time spans the lookup and the result is stamped by the injected clock`() = runTest {
    controller(this).getPermission("req-5", "draw_overlay", requestPermission = false)

    // Start at 1000, end at 1025, then the result timestamp reads 1050.
    val result = result()
    assertEquals(25L, result.totalTimeMs)
    assertEquals(1_050L, result.timestamp)
  }

  @Test
  fun `a throwing lookup becomes a correlated error instead of a hang`() = runTest {
    permissions.failWith = IllegalStateException("settings unavailable")

    controller(this).getPermission("req-6", "draw_overlay", requestPermission = null)

    assertTrue(transport.sentResponses.isEmpty())
    assertEquals("req-6", errors.single().requestId)
  }
}
