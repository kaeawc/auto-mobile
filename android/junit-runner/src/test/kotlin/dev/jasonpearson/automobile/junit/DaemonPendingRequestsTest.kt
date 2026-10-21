package dev.jasonpearson.automobile.junit

import java.io.BufferedWriter
import java.io.StringWriter
import java.util.TreeMap
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DaemonPendingRequestsTest {
  private class FakeClock : DaemonRequestClock {
    var timeMs = 10_000L
    private val events = TreeMap<Long, () -> Unit>()

    fun at(elapsedMs: Long, action: () -> Unit) {
      events[10_000L + elapsedMs] = action
    }

    override fun nowMs(): Long = timeMs

    override fun await(
      future: CompletableFuture<DaemonResponse>,
      timeoutMs: Long,
    ): DaemonResponse {
      val until = timeMs + timeoutMs
      while (events.isNotEmpty() && events.firstKey() <= until) {
        val event = events.pollFirstEntry()
        timeMs = event.key
        event.value()
        if (future.isDone) return future.get()
      }
      timeMs = until
      if (future.isDone) return future.get()
      throw TimeoutException()
    }
  }

  private val clock = FakeClock()
  private val requests = DaemonPendingRequests(BufferedWriter(StringWriter()), clock)
  private val request =
    DaemonRequest(
      "request",
      "mcp_request",
      "tools/call",
      kotlinx.serialization.json.JsonObject(emptyMap()),
    )
  private val response = DaemonResponse(request.id, "mcp_response", true)

  @Test
  fun `timeout includes two seconds of response grace`() {
    val error =
      assertThrows(DaemonUnavailableException::class.java) { requests.execute(request, 1000) }

    assertEquals(13_000L, clock.timeMs)
    assertEquals("Daemon request timeout after 1000ms", error.message)
    assertEquals(0, requests.size)
  }

  @Test
  fun `larger adopted budget survives the original deadline`() {
    clock.at(500) { requests.adoptBudget(request.id, 4000) }
    clock.at(5000) { requests.handleResponse(response) }

    assertEquals(response, requests.execute(request, 1000))
    assertEquals(15_000L, clock.timeMs)
    assertEquals(0, requests.size)
  }

  @Test
  fun `smaller adopted budget is measured from send time`() {
    clock.at(1500) { requests.adoptBudget(request.id, 2000) }

    val error =
      assertThrows(DaemonUnavailableException::class.java) { requests.execute(request, 10_000) }

    assertEquals(14_000L, clock.timeMs)
    assertEquals("Daemon request timeout after 2000ms", error.message)
    assertEquals(0, requests.size)
  }

  @Test
  fun `unknown nonpositive and unchanged budgets are ignored`() {
    clock.at(500) {
      requests.adoptBudget("unknown", 5000)
      requests.adoptBudget(request.id, 0)
      requests.adoptBudget(request.id, -1)
      requests.adoptBudget(request.id, 1000)
    }

    assertThrows(DaemonUnavailableException::class.java) { requests.execute(request, 1000) }

    assertEquals(13_000L, clock.timeMs)
    assertEquals(0, requests.size)
  }

  @Test
  fun `response in the grace window completes normally`() {
    clock.at(2500) { requests.handleResponse(response) }

    assertEquals(response, requests.execute(request, 1000))
    assertEquals(12_500L, clock.timeMs)
    assertEquals(0, requests.size)
  }

  @Test
  fun `budget announcement after its deadline expires immediately`() {
    clock.at(4500) { requests.adoptBudget(request.id, 1000) }

    assertThrows(DaemonUnavailableException::class.java) { requests.execute(request, 10_000) }

    assertEquals(14_500L, clock.timeMs)
  }
}
