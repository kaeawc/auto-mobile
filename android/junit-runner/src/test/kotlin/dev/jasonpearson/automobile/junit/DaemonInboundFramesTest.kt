package dev.jasonpearson.automobile.junit

import kotlinx.serialization.SerializationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class DaemonInboundFramesTest {
  private val budgets = mutableListOf<Pair<String, Long>>()
  private val responses = mutableListOf<DaemonResponse>()
  private val frames =
    DaemonInboundFrames(
      onResponse = { responses += it },
      onBudget = { id, budget -> budgets += id to budget },
    )

  @Test
  fun `request budget notification adopts the announced budget`() {
    frames.handle(
      """{"type":"daemon_notification","method":"notifications/automobile/requestBudget","requestId":"r","timeoutMs":90000}""",
    )

    assertEquals(listOf("r" to 90_000L), budgets)
    assertEquals(emptyList<DaemonResponse>(), responses)
  }

  @Test
  fun `unrelated notifications are silently ignored`() {
    frames.handle("""{"type":"daemon_notification","method":"notifications/progress"}""")

    assertEquals(emptyList<Pair<String, Long>>(), budgets)
    assertEquals(emptyList<DaemonResponse>(), responses)
  }

  @Test
  fun `budget notifications require a string id and numeric timeout`() {
    listOf(
        """"requestId":7,"timeoutMs":90000""",
        """"requestId":"r","timeoutMs":"90000"""",
        """"requestId":"r","timeoutMs":null""",
        """"requestId":"r"""",
      )
      .forEach { fields ->
        frames.handle(
          """{"type":"daemon_notification","method":"notifications/automobile/requestBudget",$fields}""",
        )
      }

    assertEquals(emptyList<Pair<String, Long>>(), budgets)
    assertEquals(emptyList<DaemonResponse>(), responses)
  }

  @Test
  fun `normal response is decoded with unknown keys tolerated`() {
    frames.handle("""{"id":"r","type":"mcp_response","success":true,"extra":1}""")

    assertEquals(listOf(DaemonResponse("r", "mcp_response", true)), responses)
    assertEquals(emptyList<Pair<String, Long>>(), budgets)
  }

  @Test
  fun `malformed json and responses still throw for the resilient reader to handle`() {
    listOf("{", """{"type":"mcp_response"}""").forEach { line ->
      assertThrows(SerializationException::class.java) { frames.handle(line) }
    }
  }
}
