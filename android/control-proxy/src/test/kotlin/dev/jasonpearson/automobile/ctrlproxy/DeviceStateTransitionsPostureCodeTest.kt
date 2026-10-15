package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.FoldPosture
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.Kind
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.postureCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceStateTransitionsPostureCodeTest {
  private fun combinations(): List<FoldPosture> =
    Kind.entries.flatMap { state ->
      listOf(false, true).flatMap { vertical ->
        listOf(false, true).map { separating -> FoldPosture(state, vertical, separating) }
      }
    }

  @Test
  fun `empty features have code zero`() {
    assertEquals(0, postureCode(emptyList()))
  }

  @Test
  fun `each posture combination has a distinct nonzero stable code`() {
    val features = combinations()
    val codes = features.map { postureCode(listOf(it)) }
    assertEquals(8, codes.toSet().size)
    assertEquals((1..8).toList(), codes)
    assertTrue(codes.all { it > 0 })
    assertEquals(codes, features.map { postureCode(listOf(it.copy())) })
  }

  @Test
  fun `multiple features select minimum code independent of order or duplicates`() {
    val features = combinations()
    val expected = features.minOf { postureCode(listOf(it)) }
    assertEquals(expected, postureCode(features))
    assertEquals(expected, postureCode(features.reversed()))
    assertEquals(expected, postureCode(features + features))
    for (left in features) {
      for (right in features) {
        assertEquals(postureCode(listOf(left, right)), postureCode(listOf(right, left)))
      }
    }
  }
}
