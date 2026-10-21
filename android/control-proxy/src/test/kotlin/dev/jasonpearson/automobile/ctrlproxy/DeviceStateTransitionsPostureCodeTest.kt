package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.FoldPosture
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.Kind
import dev.jasonpearson.automobile.ctrlproxy.DeviceStateTransitions.postureCode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceStateTransitionsPostureCodeTest {
  private fun combinations(): List<FoldPosture> =
    Kind.entries.flatMap { state ->
      listOf(false, true).map { separating -> FoldPosture(state, separating) }
    }

  @Test
  fun `empty features have code zero`() {
    assertEquals(0, postureCode(emptyList()))
  }

  @Test
  fun `each posture combination has a distinct nonzero stable code`() {
    val features = combinations()
    val codes = features.map { postureCode(listOf(it)) }
    assertEquals(listOf(1, 2, 4, 8), codes)
    assertTrue(codes.all { it > 0 })
    assertEquals(codes, features.map { postureCode(listOf(it.copy())) })
  }

  @Test
  fun `distinct feature subsets have distinct codes independent of order or duplicates`() {
    val features = combinations()
    val codes = mutableListOf<Int>()
    for (mask in 1 until (1 shl features.size)) {
      val subset = features.filterIndexed { index, _ -> mask and (1 shl index) != 0 }
      val code = postureCode(subset)
      codes.add(code)
      assertEquals(code, postureCode(subset.reversed()))
      assertEquals(code, postureCode(subset + subset))
    }
    assertEquals((1..15).toList(), codes.sorted())
    assertEquals(15, codes.toSet().size)
  }

  @Test
  fun `separation and state pairs do not collide`() {
    assertNotEquals(
      postureCode(listOf(FoldPosture(Kind.FLAT, false), FoldPosture(Kind.FLAT, true))),
      postureCode(listOf(FoldPosture(Kind.FLAT, false), FoldPosture(Kind.HALF_OPENED, true))),
    )
  }

  @Test
  fun `pair order does not change code`() {
    val features = combinations()
    for (left in features) {
      for (right in features) {
        assertEquals(postureCode(listOf(left, right)), postureCode(listOf(right, left)))
      }
    }
  }
}
