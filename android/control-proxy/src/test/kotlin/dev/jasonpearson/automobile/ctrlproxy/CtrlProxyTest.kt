package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

class CtrlProxyTest {
  @Test
  fun `event ingestion waits for websocket bind before draining queued events`() = runTest {
    var running = false
    val queued =
      ArrayDeque<String>().apply {
        add("navigation")
        add("sdk")
      }
    val delivered = mutableListOf<String>()
    val job = launch {
      startEventIngestionWhenReady(
        isRunning = { running },
        pause = { kotlinx.coroutines.delay(50L) },
      ) {
        while (queued.isNotEmpty()) delivered.add(queued.removeFirst())
      }
    }

    runCurrent()
    advanceTimeBy(50L)
    runCurrent()
    assertEquals(listOf("navigation", "sdk"), queued.toList())
    assertEquals(emptyList<String>(), delivered)

    running = true
    advanceTimeBy(50L)
    runCurrent()
    job.join()
    assertEquals(listOf("navigation", "sdk"), delivered)
  }
}
