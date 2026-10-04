package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DragStrokePlanTest {
  private val from = GesturePoint(10f, 20f)
  private val to = GesturePoint(100f, 200f)

  @Test
  fun `default drag is one press move hold continuation chain`() {
    val plan = dragStrokePlan(from, to, 600L, 300L, 100L)
    assertEquals(listOf(600L, 300L, 100L), plan.map { it.durationMs })
    assertEquals(1_000L, plan.sumOf { it.durationMs })
    assertEquals(listOf(from, from, to), plan.map { it.from })
    assertEquals(listOf(from, to, to), plan.map { it.to })
    assertEquals(listOf(true, false, true), plan.map { it.isHold })
    assertChain(plan)
  }

  @Test
  fun `zero distance plan stays at the exact point for every phase`() {
    val plan = dragStrokePlan(from, from, 600L, 300L, 100L)
    assertEquals(listOf(from, from, from), plan.map { it.from })
    assertEquals(listOf(from, from, from), plan.map { it.to })
    assertTrue(plan.all { it.isHold })
    assertEquals(listOf(600L, 300L, 100L), plan.map { it.durationMs })
    assertChain(plan)
  }

  @Test
  fun `travel duration is at least one millisecond`() {
    for (duration in listOf(0L, -1L, 1L)) {
      val plan = dragStrokePlan(from, to, 0L, duration, 0L)
      assertEquals(1L, plan.single().durationMs)
      assertChain(plan)
    }
  }

  @Test
  fun `press and drag without hold lift on the move`() {
    val plan = dragStrokePlan(from, to, 500L, 1_000L, 0L)
    assertEquals(listOf(500L, 1_000L), plan.map { it.durationMs })
    assertEquals(listOf(from, from), plan.map { it.from })
    assertEquals(listOf(from, to), plan.map { it.to })
    assertEquals(to, plan.last().to)
    assertChain(plan)
  }

  @Test
  fun `zero press starts with travel and continues only for positive hold`() {
    for (hold in listOf(0L, 100L)) {
      val plan = dragStrokePlan(from, to, 0L, 1_000L, hold)
      assertEquals(if (hold > 0) 2 else 1, plan.size)
      assertEquals(from, plan.first().from)
      assertEquals(to, plan.first().to)
      assertFalse(plan.first().isHold)
      assertChain(plan)
    }
  }

  private fun assertChain(plan: List<GestureSegment>) {
    assertEquals(1, plan.count { it.isInitial })
    assertTrue(plan.first().isInitial)
    assertTrue(plan.dropLast(1).all { it.willContinue })
    assertFalse(plan.last().willContinue)
    assertTrue(plan.zipWithNext().all { (a, b) -> a.to == b.from })
  }
}
