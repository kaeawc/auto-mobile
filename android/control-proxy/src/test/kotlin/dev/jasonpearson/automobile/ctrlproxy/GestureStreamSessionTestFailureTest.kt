package dev.jasonpearson.automobile.ctrlproxy

import kotlinx.coroutines.ExperimentalCoroutinesApi
import org.junit.Assert.assertEquals
import org.junit.Test

/** Stroke construction, dispatch, rejection, and release failures finish exactly once. */
@OptIn(ExperimentalCoroutinesApi::class)
internal class GestureStreamSessionTestFailureTest : GestureStreamSessionTestFixtures() {

  @Test
  fun `initial and continuation build exceptions finish once without escaping`() {
    val message = "Path bounds must not be negative"
    for (initial in listOf(true, false)) {
      val error = IllegalArgumentException(message)
      val dispatcher =
        if (initial) FakeStrokeDispatcher(initialError = error) else FakeStrokeDispatcher()
      val h = Session(dispatcher)
      h.session.start(-5f, 10f, 7)
      if (!initial) {
        h.session.move(-5f, 30f)
        h.dispatcher.completeLast()
        h.dispatcher.nextContinueError = error
        h.session.move(20f, 30f)
        h.dispatcher.completeLast()
        h.assertRelease(h.dispatcher.calls[1].stroke, GesturePoint(0f, 30f))
        assertEquals(listOf(7, 7, 7), h.dispatcher.displays)
        h.session.move(40f, 50f)
        h.session.end(40f, 50f, cancel = false)
        h.session.cancel()
        assertEquals(3, h.dispatcher.dispatched.size)
        h.dispatcher.completeLast()
      } else {
        assertEquals(0, h.dispatcher.continueCount)
      }

      h.assertFailedOnce(message)
      val dispatchedCount = h.dispatcher.dispatched.size
      assertEquals(if (initial) 0 else 3, dispatchedCount)
      h.session.move(40f, 50f)
      h.session.end(40f, 50f, cancel = false)
      h.session.cancel()
      h.dispatcher.calls.lastOrNull()?.complete?.invoke()
      assertEquals(dispatchedCount, h.dispatcher.dispatched.size)
      h.assertFailedOnce(message)
    }
  }

  @Test
  fun `dispatch exceptions finish once even when stored callbacks fire later`() {
    for (initial in listOf(true, false)) {
      for (complete in listOf(true, false)) {
        val dispatcher =
          if (initial) FakeStrokeDispatcher(dispatchError = IllegalStateException())
          else FakeStrokeDispatcher()
        val h = Session(dispatcher)
        h.session.start(10f, 10f)
        if (!initial) {
          h.dispatcher.nextDispatchError = IllegalStateException()
          h.session.move(20f, 30f)
          h.dispatcher.completeLast()
          h.assertRelease(h.dispatcher.calls.first().stroke, GesturePoint(10f, 10f))
        }
        val failedCall = h.dispatcher.calls[if (initial) 0 else 1]

        h.session.move(40f, 50f)
        h.session.end(40f, 50f, cancel = false)
        h.session.cancel()
        if (complete) failedCall.complete() else failedCall.fail("late failure")
        failedCall.reject("late rejection")
        assertEquals(if (initial) 1 else 3, h.dispatcher.dispatched.size)
        assertEquals(if (initial) 1 else 0, h.finishCount)
        if (!initial) h.dispatcher.completeLast()
        h.assertFailedOnce("Failed to build streamed gesture stroke")
        failedCall.complete()
        failedCall.fail("later failure")
        assertEquals(if (initial) 1 else 3, h.dispatcher.dispatched.size)
        h.assertFailedOnce("Failed to build streamed gesture stroke")
      }
    }
  }

  @Test
  fun `continued build and release build exceptions preserve the original error`() {
    val message = "Path bounds must not be negative"
    val h = Session(FakeStrokeDispatcher(continueError = IllegalStateException("release exploded")))
    h.session.start(10f, 10f)
    h.dispatcher.nextContinueError = IllegalArgumentException(message)
    h.session.move(20f, 30f)
    h.dispatcher.completeLast()

    assertEquals(2, h.dispatcher.continueCount) // failed move, then failed release
    assertEquals(1, h.dispatcher.dispatched.size)
    h.assertFailedOnce(message)
    h.session.move(40f, 50f)
    h.session.end(40f, 50f, cancel = false)
    h.dispatcher.calls.first().complete()
    h.dispatcher.calls.first().fail("late failure")
    assertEquals(1, h.dispatcher.dispatched.size)
    h.assertFailedOnce(message)
  }

  @Test
  fun `initial dispatch rejection finishes without releasing an unregistered pointer`() {
    val h = Session()
    h.session.start(10f, 10f)
    val rejectedCall = h.dispatcher.calls.single()
    h.dispatcher.rejectLast("initial dispatch refused")

    assertEquals(0, h.dispatcher.continueCount)
    h.assertFailedOnce("initial dispatch refused")
    rejectedCall.complete()
    rejectedCall.fail("late cancellation")
    h.session.move(20f, 30f)
    h.session.end(20f, 30f, cancel = false)
    assertEquals(1, h.dispatcher.dispatched.size)
    h.assertFailedOnce("initial dispatch refused")
  }

  @Test
  fun `release dispatch failure rejection or exception preserves the original error`() {
    for (failure in listOf("failure", "rejection", "exception")) {
      val message = "Path bounds must not be negative"
      val h = Session()
      h.session.start(10f, 10f, 7)
      h.dispatcher.nextContinueError = IllegalArgumentException(message)
      if (failure == "exception") {
        h.dispatcher.nextDispatchError = IllegalStateException("release dispatch exploded")
      }
      h.session.move(20f, 30f)
      h.dispatcher.completeLast()

      if (failure != "exception") {
        h.assertRelease(h.dispatcher.calls.first().stroke, GesturePoint(10f, 10f))
        if (failure == "failure") h.dispatcher.failLast("release cancelled")
        else h.dispatcher.rejectLast("release refused")
      }
      assertEquals(2, h.dispatcher.dispatched.size)
      assertEquals(listOf(7, 7), h.dispatcher.displays)
      h.assertFailedOnce(message)
      val release = h.dispatcher.calls.last()
      release.complete()
      release.fail("late release failure")
      release.reject("late release rejection")
      h.session.move(40f, 50f)
      h.session.end(40f, 50f, cancel = false)
      assertEquals(2, h.dispatcher.dispatched.size)
      h.assertFailedOnce(message)
    }
  }

  @Test
  fun `rejection releases the preceding stroke but cancellation releases the current stroke`() {
    for (rejected in listOf(true, false)) {
      val h = Session()
      h.session.start(-5f, 10f, 7)
      h.session.move(-5f, 30f)
      h.dispatcher.completeLast()
      val failedCall = h.dispatcher.calls.last()
      val message = if (rejected) "dispatch refused" else "dispatch cancelled"
      if (rejected) h.dispatcher.rejectLast(message) else h.dispatcher.failLast(message)

      val anchor = if (rejected) h.dispatcher.calls.first().stroke else failedCall.stroke
      h.assertRelease(anchor, GesturePoint(0f, if (rejected) 10f else 30f))
      assertEquals(listOf(7, 7, 7), h.dispatcher.displays)
      failedCall.complete()
      failedCall.fail("duplicate failure")
      failedCall.reject("duplicate rejection")
      h.session.move(40f, 50f)
      h.session.end(40f, 50f, cancel = false)
      h.session.cancel()
      assertEquals(3, h.dispatcher.dispatched.size)
      assertEquals(0, h.finishCount)

      val release = h.dispatcher.calls.last()
      h.dispatcher.completeLast()
      release.complete()
      release.fail("late failure")
      failedCall.complete()
      h.session.move(60f, 70f)
      h.session.end(60f, 70f, cancel = false)
      assertEquals(3, h.dispatcher.dispatched.size)
      h.assertFailedOnce(message)
    }
  }

  @Test
  fun `a dispatch failure finishes the session once with the error`() {
    val h = Session()
    h.session.start(10f, 10f)

    h.dispatcher.failLast("dispatchGesture refused")

    h.assertRelease(h.dispatcher.calls.first().stroke, GesturePoint(10f, 10f))
    assertEquals(2, h.dispatcher.dispatched.size)
    h.dispatcher.completeLast()
    assertEquals(1, h.finishCount)
    assertEquals(false, h.finishedSuccess)
    assertEquals("dispatchGesture refused", h.finishedError)
  }
}
