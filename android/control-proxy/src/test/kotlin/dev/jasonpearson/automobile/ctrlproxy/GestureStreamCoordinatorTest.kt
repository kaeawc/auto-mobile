package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure runner-side continuation state machine (streaming gesture input). Pins the exact segment
 * sequence a live drag produces — the initial press, moves that stay down, stationary holds between
 * moves, and the single lifting final stroke — because the whole point of streaming is that these
 * strokes chain via `willContinue`/`continueStroke`, and a machine that lifted early or never
 * lifted would still pass a laxer test.
 */
class GestureStreamCoordinatorTest {

  private fun coordinator() =
    GestureStreamCoordinator(moveSegmentDurationMs = 16, pressDurationMs = 32)

  private fun dispatch(action: GestureStreamAction): GestureSegment {
    assertTrue("expected Dispatch, was $action", action is GestureStreamAction.Dispatch)
    return (action as GestureStreamAction.Dispatch).segment
  }

  @Test
  fun `start presses in place with an initial continuing stroke`() {
    val seg = dispatch(coordinator().start(100f, 200f))

    assertEquals(GesturePoint(100f, 200f), seg.from)
    assertEquals(GesturePoint(100f, 200f), seg.to)
    assertTrue("the first segment is a fresh StrokeDescription", seg.isInitial)
    assertTrue("a stationary press", seg.isHold)
    assertTrue("more strokes follow the press", seg.willContinue)
  }

  @Test
  fun `a buffered move travels to the new point while staying down`() {
    val c = coordinator()
    c.start(100f, 200f)
    c.move(100f, 260f)

    val seg = dispatch(c.next())
    assertEquals(GesturePoint(100f, 200f), seg.from)
    assertEquals(GesturePoint(100f, 260f), seg.to)
    assertFalse("continuations are not fresh strokes", seg.isInitial)
    assertFalse("a real move, not a hold", seg.isHold)
    assertTrue("still dragging", seg.willContinue)
  }

  @Test
  fun `moves are last-wins so a backlog jumps to the newest target`() {
    val c = coordinator()
    c.start(0f, 0f)
    c.move(0f, 10f)
    c.move(0f, 20f)
    c.move(0f, 30f) // three moves arrived during one in-flight segment

    val seg = dispatch(c.next())
    assertEquals("only the newest target is used", GesturePoint(0f, 30f), seg.to)
    // Nothing left buffered: with no further move and not ended, the next action is Wait.
    assertTrue(c.next() is GestureStreamAction.Wait)
  }

  @Test
  fun `with no fresh move and not ended the coordinator waits and dispatches nothing`() {
    val c = coordinator()
    c.start(50f, 50f)

    // No keep-alive stroke: dispatching a stationary hold continuation is what the framework
    // cancels, so idle returns Wait (the willContinue press already holds the finger down).
    assertTrue(c.next() is GestureStreamAction.Wait)
    // Still parked until real input arrives.
    assertTrue(c.next() is GestureStreamAction.Wait)
  }

  @Test
  fun `a move after a wait resumes with a real continuation`() {
    val c = coordinator()
    c.start(50f, 50f)
    assertTrue(c.next() is GestureStreamAction.Wait)

    c.move(50f, 300f)
    val seg = dispatch(c.next())
    assertEquals(GesturePoint(50f, 300f), seg.to)
    assertFalse("a real move, not a hold", seg.isHold)
    assertTrue(seg.willContinue)
  }

  @Test
  fun `end travels to the released point with the single lifting stroke`() {
    val c = coordinator()
    c.start(100f, 100f)
    c.move(100f, 400f)
    dispatch(c.next()) // consume the move to (100,400)
    c.end(100f, 500f)

    val lift = dispatch(c.next())
    assertEquals(GesturePoint(100f, 400f), lift.from)
    assertEquals(GesturePoint(100f, 500f), lift.to)
    assertFalse("the final stroke lifts the finger", lift.willContinue)

    // Once lifted, the machine is done.
    assertTrue(c.next() is GestureStreamAction.Done)
  }

  @Test
  fun `a pending move is delivered before the final lift on end`() {
    val c = coordinator()
    c.start(0f, 0f)
    c.move(0f, 100f) // buffered but not yet consumed
    c.end(0f, 100f)

    // The move is delivered first (still continuing)...
    val move = dispatch(c.next())
    assertEquals(GesturePoint(0f, 100f), move.to)
    assertTrue(move.willContinue)
    // ...then the lift.
    val lift = dispatch(c.next())
    assertFalse(lift.willContinue)
    assertTrue(c.next() is GestureStreamAction.Done)
  }

  @Test
  fun `cancel lifts in place and ignores the released point`() {
    val c = coordinator()
    c.start(100f, 100f)
    c.move(100f, 300f)
    dispatch(c.next()) // now at (100,300)
    c.end(999f, 999f, cancel = true)

    val lift = dispatch(c.next())
    assertEquals("lifts where it was, not at the end point", GesturePoint(100f, 300f), lift.to)
    assertFalse(lift.willContinue)
    assertTrue(c.next() is GestureStreamAction.Done)
  }

  @Test
  fun `an idle drag never lifts on its own — only end or cancel lifts`() {
    val c = coordinator()
    c.start(10f, 10f)
    // No matter how many times the idle machine is polled, it waits (the touch stays held); it
    // never synthesizes a lift, because only the user's release ends a live drag.
    repeat(20) { assertTrue(c.next() is GestureStreamAction.Wait) }
    c.end(10f, 10f)
    val lift = dispatch(c.next())
    assertFalse(lift.willContinue)
    assertTrue(c.next() is GestureStreamAction.Done)
  }
}
