package dev.jasonpearson.automobile.ctrlproxy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class FakeGestureDeadline : GestureDeadline {
  data class Task(val delayMs: Long, val callback: () -> Unit, var cancelled: Boolean = false)

  val tasks = mutableListOf<Task>()

  override fun schedule(delayMs: Long, onTimeout: () -> Unit): () -> Unit {
    val task = Task(delayMs, onTimeout)
    tasks.add(task)
    return { task.cancelled = true }
  }

  fun expire() = tasks.last { !it.cancelled }.callback()
}

class DragStrokeSessionTest {
  private class Stroke(val segment: GestureSegment, val parent: Stroke?)

  private class Dispatcher : StrokeDispatcher<Stroke> {
    data class Call(
      val stroke: Stroke,
      val display: Int?,
      val complete: () -> Unit,
      val fail: (String) -> Unit,
    )

    val calls = mutableListOf<Call>()
    var throwNext = false
    var rejectNext = false
    var throwOnContinue = false

    override fun initialStroke(segment: GestureSegment) = Stroke(segment, null)

    override fun continueStroke(previous: Stroke, segment: GestureSegment): Stroke {
      if (throwOnContinue) {
        throwOnContinue = false
        throw IllegalStateException("build exploded")
      }
      return Stroke(segment, previous)
    }

    override fun dispatch(
      stroke: Stroke,
      onComplete: () -> Unit,
      onFailed: (String) -> Unit,
      displayId: Int?,
    ) = dispatchContinuing(stroke, onComplete, onFailed, onFailed, displayId)

    override fun dispatchContinuing(
      stroke: Stroke,
      onComplete: () -> Unit,
      onFailed: (String) -> Unit,
      onRejected: (String) -> Unit,
      displayId: Int?,
    ) {
      calls.add(Call(stroke, displayId, onComplete, onFailed))
      if (throwNext) {
        throwNext = false
        throw IllegalStateException("dispatch exploded")
      }
      if (rejectNext) {
        rejectNext = false
        onRejected("not dispatched")
      }
    }
  }

  private class FakeClock {
    var nowMs = 10_000L

    fun advance(durationMs: Long) {
      nowMs += durationMs
    }
  }

  private class Harness(
    plan: List<GestureSegment> =
      dragStrokePlan(GesturePoint(1f, 2f), GesturePoint(3f, 4f), 600L, 300L, 100L)
  ) {
    val dispatcher = Dispatcher()
    val timer = FakeGestureDeadline()
    val clock = FakeClock()
    val results = mutableListOf<Pair<Boolean, String?>>()
    val errors = mutableListOf<Exception>()
    val session =
      DragStrokeSession(
        plan,
        dispatcher,
        timer,
        7,
        { errors.add(it) },
        { success, error -> results.add(success to error) },
        nowMs = { clock.nowMs },
      )

    fun complete(elapsedMs: Long = dispatcher.calls.last().stroke.segment.durationMs) {
      clock.advance(elapsedMs)
      dispatcher.calls.last().complete()
    }

    fun assertRelease() {
      val release = dispatcher.calls.last().stroke
      assertFalse(release.segment.isInitial)
      assertFalse(release.segment.willContinue)
      assertTrue(release.segment.isHold)
      assertEquals(release.parent!!.segment.to, release.segment.from)
      assertTrue(dispatcher.calls.all { it.display == 7 })
      assertTrue(results.isEmpty())
    }
  }

  @Test
  fun `instant press completion fails and lifts pointer before reporting original error`() {
    val h = Harness()
    h.session.start()
    h.complete(0L)
    assertEquals(2, h.dispatcher.calls.size)
    h.assertRelease()
    val release = h.dispatcher.calls.last().stroke.segment
    assertEquals(release.from, release.to)
    assertEquals(1L, release.durationMs)
    h.complete(0L)
    assertEquals(listOf(false to "Drag stroke completed early: 0ms of 600ms"), h.results)
    assertTrue(h.timer.tasks.all { it.cancelled })
  }

  @Test
  fun `completion at tolerance succeeds but one millisecond earlier fails`() {
    for (elapsed in listOf(550L, 549L)) {
      val h = Harness()
      h.session.start()
      h.complete(elapsed)
      if (elapsed == 550L) {
        repeat(2) { h.complete() }
        assertEquals(listOf(true to null), h.results)
      } else {
        h.assertRelease()
        h.complete(0L)
        assertEquals(listOf(false to "Drag stroke completed early: 549ms of 600ms"), h.results)
      }
    }
  }

  @Test
  fun `early final hold completion fails and releases previous continued stroke`() {
    val h = Harness()
    h.session.start()
    repeat(2) { h.complete() }
    h.complete(0L)
    h.assertRelease()
    assertEquals(h.dispatcher.calls[1].stroke, h.dispatcher.calls.last().stroke.parent)
    h.complete(0L)
    assertEquals(listOf(false to "Drag stroke completed early: 0ms of 100ms"), h.results)
  }

  @Test
  fun `tiny durations do not trip early completion check`() {
    for (duration in listOf(1L, 50L)) {
      val h = Harness(dragStrokePlan(GesturePoint(1f, 2f), GesturePoint(3f, 4f), 0L, duration, 0L))
      h.session.start()
      h.complete(0L)
      assertEquals(1, h.dispatcher.calls.size)
      assertEquals(listOf(true to null), h.results)
    }
  }

  @Test
  fun `success waits for final completion and ignores duplicate callbacks`() {
    val h = Harness()
    h.session.start()
    repeat(2) { h.complete() }
    assertTrue(h.results.isEmpty())
    assertEquals(3, h.dispatcher.calls.size)
    assertEquals(1, h.dispatcher.calls.count { it.stroke.parent == null })
    h.complete()
    h.dispatcher.calls.first().fail("late cancellation")
    assertEquals(listOf(true to null), h.results)
    assertTrue(h.timer.tasks.all { it.cancelled })
  }

  @Test
  fun `mid chain cancellation releases pointer before reporting failure`() {
    val h = Harness()
    h.session.start()
    h.complete()
    val cancelled = h.dispatcher.calls.last()
    cancelled.fail("cancelled")
    h.assertRelease()
    cancelled.complete()
    assertEquals(3, h.dispatcher.calls.size)
    h.dispatcher.calls.last().complete()
    assertEquals(listOf(false to "cancelled"), h.results)
  }

  @Test
  fun `rejected dispatch and exception release and report failure`() {
    for (throws in listOf(false, true)) {
      val h = Harness()
      h.session.start()
      h.dispatcher.throwNext = throws
      h.dispatcher.rejectNext = !throws
      h.complete()
      h.assertRelease()
      assertEquals(h.dispatcher.calls.first().stroke, h.dispatcher.calls.last().stroke.parent)
      h.dispatcher.calls.last().complete()
      assertFalse(h.results.single().first)
      assertEquals(if (throws) "dispatch exploded" else "not dispatched", h.results.single().second)
      assertEquals(if (throws) 1 else 0, h.errors.size)
    }
  }

  @Test
  fun `stroke timeout releases pointer and cleanup timeout cannot hang result`() {
    val h = Harness()
    h.session.start()
    h.complete()
    h.timer.expire()
    h.assertRelease()
    h.timer.expire()
    h.dispatcher.calls.last().complete()
    assertFalse(h.results.single().first)
    assertTrue(h.results.single().second!!.contains("timed out"))
    assertTrue(h.timer.tasks.all { it.cancelled })
  }

  @Test
  fun `failed final segment attempts lift and cleanup rejection remains failure`() {
    val h = Harness()
    h.session.start()
    repeat(2) { h.complete() }
    h.dispatcher.calls.last().fail("final cancelled")
    h.assertRelease()
    h.dispatcher.calls.last().fail("release rejected")
    assertFalse(h.results.single().first)
    assertTrue(h.results.single().second!!.contains("final cancelled"))
    assertTrue(h.results.single().second!!.contains("release rejected"))
  }

  @Test
  fun `continuation construction exception releases previous stroke`() {
    val h = Harness()
    h.session.start()
    h.dispatcher.throwOnContinue = true
    h.complete()
    h.assertRelease()
    assertEquals(2, h.dispatcher.calls.size)
    h.dispatcher.calls.last().complete()
    assertEquals(listOf(false to "build exploded"), h.results)
    assertEquals(1, h.errors.size)
  }

  @Test
  fun `cleanup exception is logged and cannot turn failure into success`() {
    val h = Harness()
    h.session.start()
    h.dispatcher.throwNext = true
    h.dispatcher.calls.last().fail("cancelled")
    assertFalse(h.results.single().first)
    assertTrue(h.results.single().second!!.contains("cancelled"))
    assertTrue(h.results.single().second!!.contains("dispatch exploded"))
    assertEquals(1, h.errors.size)
    assertTrue(h.timer.tasks.all { it.cancelled })
  }

  @Test
  fun `initial dispatch refusal fails without inventing a pointer to release`() {
    val h = Harness()
    h.dispatcher.rejectNext = true
    h.session.start()
    assertEquals(1, h.dispatcher.calls.size)
    assertEquals(listOf(false to "not dispatched"), h.results)
    assertTrue(h.timer.tasks.all { it.cancelled })
  }
}
