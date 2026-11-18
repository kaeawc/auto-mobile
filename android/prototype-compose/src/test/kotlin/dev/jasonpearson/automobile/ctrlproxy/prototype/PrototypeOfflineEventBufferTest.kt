package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeEventKind
import org.junit.Assert.*
import org.junit.Test

class PrototypeOfflineEventBufferTest {
  private fun event(sequence: Long) =
    PrototypeEvent(0, "id", sequence, PrototypeEventKind.EMIT, null, null, emptyMap())

  @Test
  fun `overflow drops oldest drain preserves order and drop count is cumulative`() {
    val buffer = PrototypeOfflineEventBuffer(2)
    (1L..3L).forEach { buffer.add(event(it)) }
    assertEquals(1L, buffer.dropped)
    assertEquals(2, buffer.size)
    assertEquals(listOf(2L, 3L), buffer.drain().map { it.sequence })
    assertEquals(0, buffer.size)
    assertEquals(1L, buffer.dropped)
    assertThrows(IllegalArgumentException::class.java) { PrototypeOfflineEventBuffer(0) }
  }

  @Test
  fun `restore prepends an unsent tail before newly buffered events`() {
    val buffer = PrototypeOfflineEventBuffer(3)
    buffer.add(event(4))
    buffer.restore(listOf(event(1), event(2), event(3)))
    assertEquals(listOf(1L, 2L, 3L), buffer.drain().map { it.sequence })
    assertEquals(1L, buffer.dropped)
  }
}
