package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReceiverTeardownTest {
  @Test
  fun `every registration is released in order`() {
    val released = mutableListOf<String>()

    releaseEach(
      listOf("command" to "r1", "crash" to "r2", "ANR" to "r3"),
      release = { released += it },
      onFailure = { _, _ -> },
    )

    assertEquals(listOf("r1", "r2", "r3"), released)
  }

  @Test
  fun `a failed release is reported by name and the rest are still released`() {
    val released = mutableListOf<String>()
    val failures = mutableListOf<Pair<String, String?>>()

    releaseEach(
      listOf("command" to "r1", "package" to "gone", "crash" to "r3"),
      release = {
        if (it == "gone") throw IllegalArgumentException("Receiver not registered")
        released += it
      },
      onFailure = { name, error -> failures += name to error.message },
    )

    assertEquals(listOf("r1", "r3"), released)
    assertEquals(listOf<Pair<String, String?>>("package" to "Receiver not registered"), failures)
  }

  @Test
  fun `nothing to release reports nothing`() {
    var failures = 0
    releaseEach(emptyList<Pair<String, String>>(), release = {}, onFailure = { _, _ -> failures++ })
    assertTrue(failures == 0)
  }
}
