package dev.jasonpearson.automobile.desktop.core

import dev.jasonpearson.automobile.desktop.core.mcp.DaemonStatusResponse
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.junit.Test

class DaemonStatusStateTest {
  @Test
  fun `failure distinguishes initial state and carries reason`() = runBlocking {
    val failure = IllegalStateException("status unavailable")
    val client = FakeAutoMobileClient().apply { getDaemonStatusError = failure }
    val state = fetchDaemonStatus(client)
    assertNull(state.status)
    val error = assertNotNull(state.error)
    assertSame(failure, error.exception)
    assertTrue(error.message.orEmpty().contains("status unavailable"))
    assertEquals(listOf("getDaemonStatus"), client.calls)
  }

  @Test
  fun `cancellation is rethrown without publishing error state`() = runBlocking {
    val cancellation = CancellationException("pane closed")
    val client = FakeAutoMobileClient().apply { getDaemonStatusError = cancellation }
    val initial = DaemonStatusState()
    var state = initial
    val thrown = assertFailsWith<CancellationException> { state = fetchDaemonStatus(client, state) }
    assertEquals("pane closed", thrown.message)
    assertSame(initial, state)
    assertNull(state.error)
  }

  @Test
  fun `success publishes status without error`() = runBlocking {
    val status = DaemonStatusResponse(version = "test-version")
    val client = FakeAutoMobileClient().apply { getDaemonStatusResult = status }
    val state = fetchDaemonStatus(client)
    assertSame(status, state.status)
    assertNull(state.error)
  }

  @Test
  fun `later success clears previous error`() = runBlocking {
    val client =
      FakeAutoMobileClient().apply {
        getDaemonStatusError = IllegalStateException("old failure")
      }
    val failed = fetchDaemonStatus(client)
    assertNotNull(failed.error)
    client.getDaemonStatusError = null
    val recovered = fetchDaemonStatus(client, failed)
    assertSame(client.getDaemonStatusResult, recovered.status)
    assertNull(recovered.error)
  }

  @Test
  fun `failed refresh preserves last successful status with error`() = runBlocking {
    val client = FakeAutoMobileClient()
    val loaded = fetchDaemonStatus(client)
    client.getDaemonStatusError = IllegalStateException("refresh failed")
    val failed = fetchDaemonStatus(client, loaded)
    assertSame(loaded.status, failed.status)
    assertTrue(assertNotNull(failed.error).message.orEmpty().contains("refresh failed"))
  }
}
