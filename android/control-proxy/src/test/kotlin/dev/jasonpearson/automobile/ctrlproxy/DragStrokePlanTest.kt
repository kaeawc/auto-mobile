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
    val pressEnd = GesturePoint(10f, 21f)
    assertEquals(listOf(600L, 300L, 100L), plan.map { it.durationMs })
    assertEquals(1_000L, plan.sumOf { it.durationMs })
    assertEquals(listOf(from, pressEnd, to), plan.map { it.from })
    assertEquals(listOf(pressEnd, to, to), plan.map { it.to })
    assertEquals(listOf(true, false, true), plan.map { it.isHold })
    assertChain(plan)
  }

  @Test
  fun `press nudges one pixel on dominant axis with positive x for ties`() {
    val start = GesturePoint(10.25f, 20.25f)
    val targetsAndEnds =
      listOf(
        GesturePoint(100f, 30f) to GesturePoint(11.25f, 20.25f),
        GesturePoint(-100f, 30f) to GesturePoint(9.25f, 20.25f),
        GesturePoint(20f, 200f) to GesturePoint(10.25f, 21.25f),
        GesturePoint(20f, -200f) to GesturePoint(10.25f, 19.25f),
        GesturePoint(20.25f, 30.25f) to GesturePoint(11.25f, 20.25f),
        GesturePoint(0.25f, 10.25f) to GesturePoint(11.25f, 20.25f),
        start to GesturePoint(11.25f, 20.25f),
      )
    for ((target, pressEnd) in targetsAndEnds) {
      val plan = dragStrokePlan(start, target, 2_000L, 300L, 100L)
      assertEquals(pressEnd, plan.first().to)
      assertEquals(2_000L, plan.first().durationMs)
      assertTrue(plan.first().isHold)
      assertEquals(pressEnd, plan[1].from)
      assertEquals(target, plan[1].to)
      assertEquals(target, plan.last().to)
      assertEquals(2_400L, plan.sumOf { it.durationMs })
      val roundedDx = Math.round(pressEnd.x) - Math.round(start.x)
      val roundedDy = Math.round(pressEnd.y) - Math.round(start.y)
      assertEquals(1, kotlin.math.abs(roundedDx) + kotlin.math.abs(roundedDy))
      assertChain(plan)
    }
  }

  @Test
  fun `zero distance press returns to exact target before final stationary hold`() {
    val plan = dragStrokePlan(from, from, 600L, 300L, 100L)
    val pressEnd = GesturePoint(11f, 20f)
    assertEquals(listOf(from, pressEnd, from), plan.map { it.from })
    assertEquals(listOf(pressEnd, from, from), plan.map { it.to })
    assertEquals(listOf(true, false, true), plan.map { it.isHold })
    assertEquals(listOf(600L, 300L, 100L), plan.map { it.durationMs })
    assertChain(plan)
  }

  @Test
  fun `zero length continued travel is nudged and final phase returns to target`() {
    for (press in listOf(0L, 600L)) {
      val target = if (press == 0L) from else GesturePoint(11f, 20f)
      val plan = dragStrokePlan(from, target, press, 300L, 100L)
      val travel = plan[plan.lastIndex - 1]
      assertEquals(target, travel.from)
      assertEquals(GesturePoint(target.x + 1f, target.y), travel.to)
      assertTrue(travel.isHold)
      assertEquals(travel.to, plan.last().from)
      assertEquals(target, plan.last().to)
      assertEquals(press + 400L, plan.sumOf { it.durationMs })
      assertChain(plan)
    }
  }

  @Test
  fun `final stationary travel never needs a nudge`() {
    for (press in listOf(0L, 600L)) {
      val target = if (press == 0L) from else GesturePoint(11f, 20f)
      val plan = dragStrokePlan(from, target, press, 300L, 0L)
      assertEquals(target, plan.last().from)
      assertEquals(target, plan.last().to)
      assertTrue(plan.last().isHold)
      assertChain(plan)
    }
  }

  @Test
  fun `press and drag without hold lift on the move`() {
    val plan = dragStrokePlan(from, to, 500L, 1_000L, 0L)
    assertEquals(2, plan.size)
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
