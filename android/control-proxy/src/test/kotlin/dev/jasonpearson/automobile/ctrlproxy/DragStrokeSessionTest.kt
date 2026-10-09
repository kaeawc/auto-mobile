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

  /** Equal-time tasks run in insertion order; fired tasks are no longer live. */
  private class VirtualScheduler : GestureDeadline {
    private data class Task(
      val dueMs: Long,
      val callback: () -> Unit,
      var cancelled: Boolean = false,
    )

    private val tasks = mutableListOf<Task>()
    var nowMs = 0L
      private set

    val hasLiveTasks: Boolean
      get() = tasks.any { !it.cancelled }

    override fun schedule(delayMs: Long, onTimeout: () -> Unit): () -> Unit {
      val task = Task(nowMs + delayMs, onTimeout)
      tasks.add(task)
      return { task.cancelled = true }
    }

    /** Queue an immediate callback without exposing a cancel handle. */
    fun post(callback: () -> Unit) {
      tasks.add(Task(nowMs, callback))
    }

    private fun nextTask() = tasks.filterNot { it.cancelled }.minByOrNull { it.dueMs }

    fun advanceTo(targetMs: Long) {
      require(targetMs >= nowMs)
      while (true) {
        val next = nextTask() ?: break
        if (next.dueMs > targetMs) break
        nowMs = next.dueMs
        next.cancelled = true
        next.callback()
      }
      nowMs = targetMs
    }

    fun runAll() {
      while (hasLiveTasks) advanceTo(requireNotNull(nextTask()).dueMs)
    }
  }

  private enum class Action {
    DOWN,
    MOVE,
    UP,
    CANCEL,
  }

  private data class Pixel(val x: Int, val y: Int)

  private data class Event(val timeMs: Long, val action: Action, val x: Int, val y: Int)

  /** Models measured facts 1-6, including early callbacks and a pointer held across idle gaps. */
  private class FrameworkDispatcher(
    private val scheduler: VirtualScheduler,
    var injectionLatencyMs: Long = 0L,
  ) : StrokeDispatcher<Stroke> {
    data class Attempt(val timeMs: Long, val stroke: Stroke)

    private data class Sample(val offsetMs: Long, val action: Action, val pixel: Pixel)

    private class Flight(val fail: (String) -> Unit) {
      val cancelTasks = mutableListOf<() -> Unit>()
    }

    val attempts = mutableListOf<Attempt>()
    val events = mutableListOf<Event>()
    val completions = mutableListOf<Long>()
    val failures = mutableListOf<String>()
    var pointerDown = false
      private set

    private var point: Pixel? = null
    private var active: Flight? = null

    override fun initialStroke(segment: GestureSegment) = Stroke(segment, null)

    override fun continueStroke(previous: Stroke, segment: GestureSegment) =
      Stroke(segment, previous)

    override fun dispatch(
      stroke: Stroke,
      onComplete: () -> Unit,
      onFailed: (String) -> Unit,
      displayId: Int?,
    ) {
      attempts.add(Attempt(scheduler.nowMs, stroke))
      if (!accepts(stroke)) {
        reportCancelled(onFailed)
        return
      }
      val samples = samples(stroke.segment)
      if (samples.isEmpty()) {
        // A no-event continuation fails without cancelling the existing pointer.
        reportCancelled(onFailed)
        return
      }
      inject(samples, onComplete, onFailed)
    }

    private fun accepts(stroke: Stroke): Boolean {
      if (stroke.segment.isInitial) return stroke.parent == null
      val parent = stroke.parent ?: return false
      val start = rounded(stroke.segment.from)
      return pointerDown &&
        parent.segment.willContinue &&
        start == point &&
        start == rounded(parent.segment.to)
    }

    private fun reportCancelled(onFailed: (String) -> Unit) {
      scheduler.post {
        failures.add("cancelled")
        onFailed("cancelled")
      }
    }

    private fun samples(segment: GestureSegment): List<Sample> = buildList {
      var last = rounded(segment.from)
      if (segment.isInitial) add(Sample(0L, Action.DOWN, last))
      for (elapsed in sampleTimes(segment.durationMs)) {
        val pixel = pointAt(segment, elapsed)
        if (pixel != last) add(Sample(elapsed, Action.MOVE, pixel))
        last = pixel
      }
      if (!segment.willContinue) add(Sample(segment.durationMs, Action.UP, last))
    }

    private fun sampleTimes(durationMs: Long): List<Long> = buildList {
      var elapsed = SAMPLE_INTERVAL_MS
      while (elapsed < durationMs) {
        add(elapsed)
        elapsed += SAMPLE_INTERVAL_MS
      }
      add(durationMs)
    }

    private fun pointAt(segment: GestureSegment, elapsedMs: Long): Pixel {
      val fraction = elapsedMs.toFloat() / segment.durationMs
      return rounded(
        GesturePoint(
          segment.from.x + (segment.to.x - segment.from.x) * fraction,
          segment.from.y + (segment.to.y - segment.from.y) * fraction,
        ),
      )
    }

    private fun rounded(point: GesturePoint) = Pixel(Math.round(point.x), Math.round(point.y))

    private fun inject(samples: List<Sample>, onComplete: () -> Unit, onFailed: (String) -> Unit) {
      val flight = Flight(onFailed)
      active = flight
      for (sample in samples) {
        flight.cancelTasks.add(
          scheduler.schedule(injectionLatencyMs + sample.offsetMs) {
            if (active === flight) emit(sample.action, sample.pixel)
          },
        )
      }
      // Insert after the last event at the same time, so the callback sees the updated pointer.
      flight.cancelTasks.add(
        scheduler.schedule(injectionLatencyMs + samples.last().offsetMs) {
          if (active === flight) {
            active = null
            completions.add(scheduler.nowMs)
            onComplete()
          }
        },
      )
    }

    private fun emit(action: Action, pixel: Pixel) {
      events.add(Event(scheduler.nowMs, action, pixel.x, pixel.y))
      point = pixel
      when (action) {
        Action.DOWN -> pointerDown = true
        Action.UP,
        Action.CANCEL -> pointerDown = false
        Action.MOVE -> Unit
      }
    }

    fun cancelPointer() {
      if (pointerDown) emit(Action.CANCEL, requireNotNull(point))
      val flight = active ?: return
      active = null
      flight.cancelTasks.forEach { it() }
      failures.add("cancelled")
      flight.fail("cancelled")
    }

    companion object {
      private const val SAMPLE_INTERVAL_MS = 16L
    }
  }

  private data class Result(val timeMs: Long, val success: Boolean, val error: String?)

  private class FrameworkHarness(
    press: Long = 600L,
    duration: Long = 300L,
    hold: Long = 100L,
    from: GesturePoint = GesturePoint(10f, 20f),
    to: GesturePoint = GesturePoint(410f, 220f),
    injectionLatencyMs: Long = 0L,
  ) {
    val scheduler = VirtualScheduler()
    val dispatcher = FrameworkDispatcher(scheduler, injectionLatencyMs)
    val results = mutableListOf<Result>()
    val errors = mutableListOf<Exception>()
    val session =
      DragStrokeSession(
        dragStrokePlan(from, to, press, duration, hold),
        dispatcher,
        scheduler,
        7,
        { errors.add(it) },
        { success, error -> results.add(Result(scheduler.nowMs, success, error)) },
        nowMs = { scheduler.nowMs },
      )

    fun start() {
      session.start()
      scheduler.advanceTo(0L)
    }

    fun assertSuccess(expectedMs: Long) {
      val result = results.single()
      assertTrue(result.success)
      assertEquals(null, result.error)
      assertTrue(result.timeMs >= expectedMs)
      assertTrue(result.timeMs <= expectedMs + COMPLETION_SLACK_MS)
      assertEquals(1, dispatcher.events.count { it.action == Action.DOWN })
      val up = dispatcher.events.single { it.action == Action.UP }
      assertTrue(up.timeMs >= expectedMs)
      assertFalse(dispatcher.pointerDown)
      assertTrue(dispatcher.failures.isEmpty())
      assertTrue(errors.isEmpty())
      assertFalse(scheduler.hasLiveTasks)
    }

    fun assertCancelled() {
      assertFalse(results.single().success)
      assertTrue(results.single().error!!.contains("cancelled"))
      assertEquals(1, dispatcher.events.count { it.action == Action.CANCEL })
      val release = dispatcher.attempts.last().stroke.segment
      assertEquals(1L, release.durationMs)
      assertFalse(release.willContinue)
      assertEquals(release.from, release.to)
      assertFalse(dispatcher.pointerDown)
      assertTrue(errors.isEmpty())
      assertFalse(scheduler.hasLiveTasks)
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
      dragStrokePlan(GesturePoint(1f, 2f), GesturePoint(3f, 4f), 600L, 300L, 100L),
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

    fun completePress() {
      complete()
      clock.advance(timer.tasks.last().delayMs)
      timer.expire()
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
  fun `framework long presses stay exactly stationary until travel and lift on time`() {
    for (press in listOf(600L, 1_500L, 3_000L)) {
      val h = FrameworkHarness(press = press)
      h.start()
      h.scheduler.runAll()
      h.assertSuccess(press + 400L)
      assertEquals(Event(0L, Action.DOWN, 10, 20), h.dispatcher.events.first())
      val moves = h.dispatcher.events.filter { it.action == Action.MOVE }
      assertTrue(moves.isNotEmpty())
      assertTrue(moves.all { it.timeMs >= press })
      assertEquals(410, h.dispatcher.events.last().x)
      assertEquals(220, h.dispatcher.events.last().y)
    }
  }

  @Test
  fun `framework delayed injection preserves full press and total pointer down time`() {
    val latency = 40L
    for (press in listOf(600L, 1_500L, 3_000L)) {
      for (continuationLatency in listOf(0L, latency)) {
        val h = FrameworkHarness(press = press, injectionLatencyMs = latency)
        h.start()
        h.scheduler.advanceTo(latency)
        h.dispatcher.injectionLatencyMs = continuationLatency
        h.scheduler.runAll()
        val down = h.dispatcher.events.first()
        assertEquals(Event(latency, Action.DOWN, 10, 20), down)
        val firstMove = h.dispatcher.events.first { it.action == Action.MOVE }
        assertEquals(firstMove, h.dispatcher.events[1])
        assertTrue(firstMove.timeMs - down.timeMs >= press)
        val up = h.dispatcher.events.single { it.action == Action.UP }
        assertTrue(up.timeMs - down.timeMs >= press + 400L)
        // Bound success by the plan plus all three injection delays and at most 16ms slack.
        h.assertSuccess(press + 400L + latency + 2L * continuationLatency)
      }
    }
  }

  @Test
  fun `framework instant stationary press completion is paced without failure`() {
    val h = FrameworkHarness()
    h.start()
    assertEquals(listOf(0L), h.dispatcher.completions)
    h.scheduler.advanceTo(599L)
    assertEquals(1, h.dispatcher.attempts.size)
    assertEquals(listOf(Event(0L, Action.DOWN, 10, 20)), h.dispatcher.events)
    assertTrue(h.results.isEmpty())
    h.scheduler.advanceTo(600L)
    assertEquals(600L, h.dispatcher.attempts.last().timeMs)
    h.scheduler.runAll()
    h.assertSuccess(1_000L)
  }

  @Test
  fun `framework zero distance and subpixel travel wait without dispatching empty continuations`() {
    val from = GesturePoint(10.2f, 20.2f)
    for (to in listOf(from, GesturePoint(10.4f, 20.4f))) {
      val h = FrameworkHarness(from = from, to = to)
      h.start()
      h.scheduler.advanceTo(600L)
      assertEquals(1, h.dispatcher.attempts.size)
      h.scheduler.advanceTo(899L)
      assertEquals(1, h.dispatcher.attempts.size)
      assertTrue(h.dispatcher.pointerDown)
      h.scheduler.runAll()
      h.assertSuccess(1_000L)
      assertEquals(listOf(Action.DOWN, Action.UP), h.dispatcher.events.map { it.action })
      assertEquals(900L, h.dispatcher.attempts.last().timeMs)
      assertEquals(h.dispatcher.attempts.first().stroke, h.dispatcher.attempts.last().stroke.parent)
    }
  }

  @Test
  fun `framework short travel completes early but hold starts after full travel duration`() {
    val h = FrameworkHarness(to = GesturePoint(13f, 20f))
    h.start()
    h.scheduler.advanceTo(856L)
    assertEquals(listOf(0L, 856L), h.dispatcher.completions)
    assertEquals(2, h.dispatcher.attempts.size)
    h.scheduler.advanceTo(899L)
    assertEquals(2, h.dispatcher.attempts.size)
    h.scheduler.advanceTo(900L)
    assertEquals(900L, h.dispatcher.attempts.last().timeMs)
    h.scheduler.runAll()
    h.assertSuccess(1_000L)
  }

  @Test
  fun `framework cancellation during press wait fails on next continuation and attempts lift`() {
    val h = FrameworkHarness()
    h.start()
    h.scheduler.advanceTo(300L)
    h.dispatcher.cancelPointer()
    assertTrue(h.results.isEmpty())
    assertTrue(h.dispatcher.failures.isEmpty())
    h.scheduler.runAll()
    h.assertCancelled()
    assertEquals(3, h.dispatcher.attempts.size)
    assertEquals(listOf("cancelled", "cancelled"), h.dispatcher.failures)
  }

  @Test
  fun `framework cancellation mid travel immediately fails and attempts lift`() {
    val h = FrameworkHarness()
    h.start()
    h.scheduler.advanceTo(700L)
    h.dispatcher.cancelPointer()
    assertEquals(3, h.dispatcher.attempts.size)
    h.scheduler.runAll()
    h.assertCancelled()
    assertEquals(700L, h.results.single().timeMs)
    assertEquals(listOf("cancelled", "cancelled"), h.dispatcher.failures)
  }

  @Test
  fun `framework cancellation during skipped travel wait fails on final hold and attempts lift`() {
    val h = FrameworkHarness(to = GesturePoint(10f, 20f))
    h.start()
    h.scheduler.advanceTo(700L)
    h.dispatcher.cancelPointer()
    assertTrue(h.results.isEmpty())
    assertEquals(1, h.dispatcher.attempts.size)
    h.scheduler.runAll()
    h.assertCancelled()
    assertEquals(900L, h.results.single().timeMs)
    assertEquals(3, h.dispatcher.attempts.size)
    assertEquals(h.dispatcher.attempts.first().stroke, h.dispatcher.attempts.last().stroke.parent)
  }

  @Test
  fun `framework zero press and zero hold variants keep one pointer and succeed`() {
    for ((press, hold) in listOf(600L to 0L, 0L to 100L, 0L to 0L)) {
      val h = FrameworkHarness(press = press, hold = hold)
      h.start()
      h.scheduler.runAll()
      h.assertSuccess(press + 300L + hold)
    }
  }

  @Test
  fun `framework stationary variants with zero press or hold still lift at planned time`() {
    for ((press, hold) in listOf(600L to 0L, 0L to 100L, 0L to 0L)) {
      val h = FrameworkHarness(press = press, hold = hold, to = GesturePoint(10f, 20f))
      h.start()
      h.scheduler.runAll()
      h.assertSuccess(press + 300L + hold)
      assertEquals(listOf(Action.DOWN, Action.UP), h.dispatcher.events.map { it.action })
    }
  }

  @Test
  fun `framework model completes continued paths at last rounded move`() {
    val lengthsAndTimes =
      listOf(
        0f to 0L,
        0.4f to 0L,
        1f to 304L,
        2f to 464L,
        5f to 544L,
        10f to 576L,
        20f to 592L,
      )
    for ((length, completion) in lengthsAndTimes) {
      val scheduler = VirtualScheduler()
      val dispatcher = FrameworkDispatcher(scheduler)
      val segment =
        GestureSegment(
          GesturePoint(0f, 0f),
          GesturePoint(length, 0f),
          600L,
          true,
          true,
          length == 0f,
        )
      val callbacks = mutableListOf<Long>()
      val failures = mutableListOf<String>()
      dispatcher.dispatch(
        dispatcher.initialStroke(segment),
        { callbacks.add(scheduler.nowMs) },
        { failures.add(it) },
        null,
      )
      scheduler.runAll()
      assertEquals(listOf(completion), callbacks)
      assertTrue(failures.isEmpty())
      assertTrue(dispatcher.pointerDown)
    }
  }

  @Test
  fun `framework model empty continuation fails without lifting and later rounded continuation works`() {
    val scheduler = VirtualScheduler()
    val dispatcher = FrameworkDispatcher(scheduler)
    val segment =
      GestureSegment(
        GesturePoint(10.2f, 20f),
        GesturePoint(10.2f, 20f),
        600L,
        true,
        true,
        true,
      )
    val press = dispatcher.initialStroke(segment)
    val failures = mutableListOf<String>()
    dispatcher.dispatch(press, {}, { failures.add(it) }, null)
    scheduler.runAll()
    for (end in listOf(10.2f, 10.4f)) {
      val empty =
        dispatcher.continueStroke(
          press,
          segment.copy(
            to = GesturePoint(end, 20f),
            isInitial = false,
          ),
        )
      dispatcher.dispatch(empty, {}, { failures.add(it) }, null)
      scheduler.runAll()
      assertTrue(dispatcher.pointerDown)
      assertEquals(1, dispatcher.events.size)
    }
    assertEquals(listOf("cancelled", "cancelled"), failures)
    scheduler.advanceTo(30_000L)
    val release =
      dispatcher.continueStroke(
        press,
        segment.copy(
          from = GesturePoint(10.4f, 20f),
          to = GesturePoint(10.4f, 20f),
          durationMs = 100L,
          willContinue = false,
          isInitial = false,
        ),
      )
    val completions = mutableListOf<Long>()
    dispatcher.dispatch(release, { completions.add(scheduler.nowMs) }, { failures.add(it) }, null)
    scheduler.runAll()
    assertEquals(listOf(30_100L), completions)
    assertEquals(listOf(Action.DOWN, Action.UP), dispatcher.events.map { it.action })
    assertFalse(dispatcher.pointerDown)
  }

  @Test
  fun `framework model refuses a continuation starting in another rounded pixel`() {
    val scheduler = VirtualScheduler()
    val dispatcher = FrameworkDispatcher(scheduler)
    val segment =
      GestureSegment(
        GesturePoint(10f, 20f),
        GesturePoint(10f, 20f),
        600L,
        true,
        true,
        true,
      )
    val press = dispatcher.initialStroke(segment)
    dispatcher.dispatch(press, {}, {}, null)
    scheduler.runAll()
    val wrong =
      dispatcher.continueStroke(
        press,
        segment.copy(
          from = GesturePoint(11f, 20f),
          to = GesturePoint(20f, 20f),
          isInitial = false,
        ),
      )
    val failures = mutableListOf<String>()
    dispatcher.dispatch(wrong, {}, { failures.add(it) }, null)
    scheduler.runAll()
    assertEquals(listOf("cancelled"), failures)
    assertEquals(listOf(Event(0L, Action.DOWN, 10, 20)), dispatcher.events)
  }

  @Test
  fun `instant press completion waits and ignores late duplicate callbacks`() {
    val h = Harness()
    h.session.start()
    val press = h.dispatcher.calls.single()
    h.complete(0L)
    assertEquals(1, h.dispatcher.calls.size)
    assertEquals(600L, h.timer.tasks.last().delayMs)
    press.complete()
    press.fail("late cancellation")
    assertEquals(1, h.dispatcher.calls.size)
    h.clock.advance(600L)
    val wait = h.timer.tasks.last()
    h.timer.expire()
    wait.callback()
    press.complete()
    assertEquals(2, h.dispatcher.calls.size)
    repeat(2) { h.complete() }
    assertEquals(listOf(true to null), h.results)
    assertTrue(h.timer.tasks.all { it.cancelled })
  }

  @Test
  fun `late press completion still waits the full duration from its callback`() {
    val h = Harness()
    h.session.start()
    h.complete(40L)
    assertEquals(600L, h.timer.tasks.last().delayMs)
    assertEquals(1, h.dispatcher.calls.size)
    assertTrue(h.results.isEmpty())
    h.clock.advance(600L)
    h.timer.expire()
    assertEquals(2, h.dispatcher.calls.size)
    repeat(2) { h.complete() }
    assertEquals(listOf(true to null), h.results)
    assertTrue(h.timer.tasks.all { it.cancelled })
  }

  @Test
  fun `early final completion waits before success and finish leaves no live timer`() {
    val h = Harness()
    h.session.start()
    h.completePress()
    h.complete()
    val final = h.dispatcher.calls.last()
    h.complete(0L)
    assertTrue(h.results.isEmpty())
    assertEquals(100L, h.timer.tasks.last().delayMs)
    h.clock.advance(100L)
    val wait = h.timer.tasks.last()
    h.timer.expire()
    final.fail("late cancellation")
    final.complete()
    wait.callback()
    assertEquals(3, h.dispatcher.calls.size)
    assertEquals(listOf(true to null), h.results)
    assertTrue(h.timer.tasks.all { it.cancelled })
  }

  @Test
  fun `stale pacing timer cannot dispatch after cleanup starts or finishes`() {
    val h = Harness()
    h.session.start()
    h.complete(0L)
    val wait = h.timer.tasks.last()
    h.clock.advance(600L)
    h.timer.expire()
    h.dispatcher.calls.last().fail("cancelled")
    h.assertRelease()
    wait.callback()
    assertEquals(3, h.dispatcher.calls.size)
    h.dispatcher.calls.last().complete()
    wait.callback()
    assertEquals(3, h.dispatcher.calls.size)
    assertEquals(listOf(false to "cancelled"), h.results)
    assertTrue(h.timer.tasks.all { it.cancelled })
  }

  @Test
  fun `tiny durations still wait for their planned time`() {
    for (duration in listOf(1L, 50L)) {
      val h = Harness(dragStrokePlan(GesturePoint(1f, 2f), GesturePoint(3f, 4f), 0L, duration, 0L))
      h.session.start()
      h.complete(0L)
      assertTrue(h.results.isEmpty())
      h.clock.advance(duration)
      h.timer.expire()
      assertEquals(1, h.dispatcher.calls.size)
      assertEquals(listOf(true to null), h.results)
      assertTrue(h.timer.tasks.all { it.cancelled })
    }
  }

  @Test
  fun `success waits for final completion and ignores duplicate callbacks`() {
    val h = Harness()
    h.session.start()
    h.completePress()
    h.complete()
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
    h.completePress()
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
      h.completePress()
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
    h.completePress()
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
    h.completePress()
    h.complete()
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
    h.completePress()
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

  companion object {
    // The fake omits callback delivery jitter; allow at most one sampling interval of slack.
    private const val COMPLETION_SLACK_MS = 16L
  }
}
