package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Continuation geometry, display routing, parking, and lifting. */
@OptIn(ExperimentalCoroutinesApi::class)
internal class GestureStreamSessionTestContinuationTest : GestureStreamSessionTestFixtures() {

  @Test
  fun `start display is retained through move end and cancellation`() {
    for (displayId in listOf(null, 0, 7)) {
      for (cancel in listOf(false, true)) {
        val runner = Session()
        runner.session.start(1f, 2f, displayId)
        runner.session.move(3f, 4f)
        runner.dispatcher.completeLast()
        runner.session.end(5f, 6f, cancel)
        runner.dispatcher.completeLast()
        runner.dispatcher.completeLast()
        assertEquals(listOf(displayId, displayId, displayId), runner.dispatcher.displays)
        assertEquals(true, runner.finishedSuccess)
      }
    }
  }

  @Test
  fun `start then end chains an initial press and a single lifting continuation`() {
    val h = Session()
    h.session.start(100f, 100f)

    // The first dispatched stroke is the fresh initial press.
    assertEquals(1, h.dispatcher.initialCount)
    assertTrue(h.dispatcher.dispatched[0].isInitial)

    h.session.end(100f, 200f, cancel = false)
    h.dispatcher.completeLast() // press done -> pump the lift

    val lift = h.dispatcher.dispatched[1]
    assertFalse("the lift is a continuation, not a fresh stroke", lift.isInitial)
    assertFalse("the lift stroke ends the gesture", lift.willContinue)
    assertEquals(1, h.dispatcher.continueCount)

    h.dispatcher.completeLast() // lift done -> coordinator reports Done
    assertEquals(1, h.finishCount)
    assertEquals(true, h.finishedSuccess)
    assertNull(h.finishedError)
  }

  @Test
  fun `a move chains a continuing stroke to the new point before the lift`() {
    val h = Session()
    h.session.start(0f, 0f)
    h.session.move(0f, 50f)
    h.dispatcher.completeLast() // press done -> pump the move

    val move = h.dispatcher.dispatched[1]
    assertEquals(GesturePoint(0f, 50f), move.to)
    assertTrue("mid-drag strokes keep the touch down", move.willContinue)

    h.session.end(0f, 60f, cancel = false)
    h.dispatcher.completeLast() // move done -> pump the lift
    val lift = h.dispatcher.dispatched.last()
    assertEquals(GesturePoint(0f, 60f), lift.to)
    assertFalse(lift.willContinue)

    h.dispatcher.completeLast() // lift done -> Done
    assertEquals(true, h.finishedSuccess)
  }

  @Test
  fun `negative move coordinates are clamped on every dispatched endpoint`() {
    for (target in listOf(GesturePoint(-5f, -7f), GesturePoint(-5f, 30f))) {
      val h = Session()
      h.session.start(10f, 10f)
      h.dispatcher.completeLast()
      h.session.move(target.x, target.y)

      val clampedTarget = GesturePoint(0f, target.y.coerceAtLeast(0f))
      assertEquals(GesturePoint(10f, 10f), h.dispatcher.dispatched[1].from)
      assertEquals(clampedTarget, h.dispatcher.dispatched[1].to)
      h.session.end(target.x, target.y, cancel = false)
      h.dispatcher.completeLast()
      assertEquals(clampedTarget, h.dispatcher.dispatched.last().from)
      assertEquals(clampedTarget, h.dispatcher.dispatched.last().to)
      h.dispatcher.completeLast()

      assertTrue(
        h.dispatcher.dispatched.all {
          it.from.x >= 0f && it.from.y >= 0f && it.to.x >= 0f && it.to.y >= 0f
        },
      )
      assertEquals(true, h.finishedSuccess)
    }
  }

  @Test
  fun `negative initial press and final lift are clamped and dispatched`() {
    val h = Session()
    h.session.start(-5f, -7f)
    h.dispatcher.completeLast()
    h.session.end(-5f, -7f, cancel = false)
    h.dispatcher.completeLast()

    assertEquals(2, h.dispatcher.dispatched.size)
    assertTrue(
      h.dispatcher.dispatched.all {
        it.from == GesturePoint(0f, 0f) && it.to == GesturePoint(0f, 0f)
      },
    )
    assertEquals(true, h.finishedSuccess)
  }

  @Test
  fun `collapsed negative moves park and recover with a continuous stroke before lifting`() {
    val h = Session()
    h.session.start(0f, 0f)
    h.dispatcher.completeLast()
    h.session.move(-5f, -7f)
    h.session.move(-10f, -20f)

    assertEquals(1, h.dispatcher.dispatched.size)
    assertEquals(0, h.dispatcher.continueCount)
    assertEquals(0, h.finishCount)
    assertNull(h.finishedSuccess)

    h.session.move(20f, 20f)
    assertEquals(2, h.dispatcher.dispatched.size)
    assertEquals(GesturePoint(0f, 0f), h.dispatcher.dispatched[1].from)
    assertEquals(GesturePoint(20f, 20f), h.dispatcher.dispatched[1].to)
    h.session.end(20f, 20f, cancel = false)
    h.dispatcher.completeLast()

    val lift = h.dispatcher.dispatched.last()
    assertEquals(3, h.dispatcher.dispatched.size)
    assertEquals(GesturePoint(20f, 20f), lift.from)
    assertEquals(lift.from, lift.to)
    assertFalse(lift.willContinue)
    h.dispatcher.completeLast()
    assertEquals(1, h.finishCount)
    assertEquals(true, h.finishedSuccess)
  }

  @Test
  fun `in bounds movement and genuine holds retain their exact endpoints`() {
    val h = Session()
    h.session.start(10f, 10f)
    h.dispatcher.completeLast()
    h.session.move(20f, 30f)
    h.dispatcher.completeLast()
    h.session.move(20f, 30f)
    assertTrue(h.dispatcher.dispatched.last().isHold)
    assertTrue(h.dispatcher.dispatched.last().willContinue)
    h.dispatcher.completeLast()
    h.session.end(20f, 30f, cancel = false)
    h.dispatcher.completeLast()

    assertEquals(
      listOf(
        GesturePoint(10f, 10f) to GesturePoint(10f, 10f),
        GesturePoint(10f, 10f) to GesturePoint(20f, 30f),
        GesturePoint(20f, 30f) to GesturePoint(20f, 30f),
        GesturePoint(20f, 30f) to GesturePoint(20f, 30f),
      ),
      h.dispatcher.dispatched.map { it.from to it.to },
    )
    assertEquals(1, h.dispatcher.initialCount)
    assertEquals(3, h.dispatcher.continueCount)
    assertEquals(true, h.finishedSuccess)
  }

  @Test
  fun `an idle session parks after the press and resumes on the next move`() {
    val h = Session()
    h.session.start(5f, 5f)
    assertEquals(1, h.dispatcher.dispatched.size) // the press

    // Press completes with nothing buffered: the session parks (Wait) and dispatches NOTHING —
    // no cancel-inducing keep-alive stroke, no lift.
    h.dispatcher.completeLast()
    assertEquals("no stroke dispatched while idle", 1, h.dispatcher.dispatched.size)
    assertNull("still dragging, not finished", h.finishedSuccess)

    // A move arriving while parked resumes the loop and dispatches the continuation.
    h.session.move(5f, 200f)
    assertEquals(2, h.dispatcher.dispatched.size)
    assertEquals(GesturePoint(5f, 200f), h.dispatcher.dispatched[1].to)
    assertTrue(h.dispatcher.dispatched[1].willContinue)
  }
}
