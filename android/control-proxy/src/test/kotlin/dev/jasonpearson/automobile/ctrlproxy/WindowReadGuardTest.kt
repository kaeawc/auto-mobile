package dev.jasonpearson.automobile.ctrlproxy

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
internal class WindowReadGuardTest {
  private val worker = FakeWindowReadExecutor()
  private val guard = QuarantiningWindowReadGuard(worker, nowMs = { worker.nowMs })

  @Test
  fun `healthy overlapping reads of the same window are not quarantined`() {
    val result = guard.read(1, { guard.read(1, { "healthy" }) })
    assertEquals(WindowReadResult.Completed(WindowReadResult.Completed("healthy")), result)
    assertEquals(2, worker.budgets.size)
  }

  @Test
  fun `timeout quarantines only that window and a completed retry clears quarantine`() {
    worker.durations += Long.MAX_VALUE
    var reads = 0
    assertTrue(guard.read(1, { reads += 1 }) is WindowReadResult.Skipped)
    assertEquals(0, reads)
    assertEquals(WindowReadResult.Completed("healthy"), guard.read(2, { "healthy" }))
    val submissions = worker.budgets.size
    assertTrue(guard.read(1, { reads += 1 }) is WindowReadResult.Skipped)
    assertEquals(submissions, worker.budgets.size)

    // The old Binder read eventually exits; its result is discarded and its cleanup runs.
    worker.abandonedReads.removeFirst().invoke()
    assertEquals(1, reads)
    worker.nowMs += WINDOW_READ_QUARANTINE_MS - 1
    assertTrue(guard.read(1, { reads += 1 }) is WindowReadResult.Skipped)
    worker.nowMs += 1
    assertTrue(guard.read(1, { reads += 1 }) is WindowReadResult.Completed)
    assertTrue(guard.read(1, { reads += 1 }) is WindowReadResult.Completed)
    assertEquals(3, reads)
    assertTrue(worker.budgets.all { it == WINDOW_READ_BUDGET_MS })
  }

  @Test
  fun `an indefinitely stuck worker is not duplicated after TTL`() {
    worker.durations += Long.MAX_VALUE
    guard.read(1, { "never returned" })
    worker.nowMs += WINDOW_READ_QUARANTINE_MS
    assertTrue(guard.read(1, { "must not start" }) is WindowReadResult.Skipped)
    assertEquals(1, worker.budgets.size)
    assertEquals(1, worker.abandonedReads.size)
  }

  @Test
  fun `a read completing at the budget is retained and cleaned up once`() {
    worker.durations += WINDOW_READ_BUDGET_MS
    var cleanups = 0
    assertEquals(WindowReadResult.Completed(42), guard.read(1, { 42 }, { cleanups += 1 }))
    assertEquals(WINDOW_READ_BUDGET_MS, worker.nowMs)
    assertEquals(1, cleanups)
    assertTrue(worker.abandonedReads.isEmpty())
  }

  @Test
  fun `worker timeout discards a late value without real threads or sleeps`() {
    val tasks = ArrayDeque<Runnable>()
    val executor = WorkerWindowReadExecutor(Executor { tasks.addLast(it) })
    val discarded = mutableListOf<String>()
    var read = false
    assertEquals(
      WindowReadResult.Skipped("timeout"),
      executor.read(
        0,
        {
          read = true
          "late"
        },
        { discarded += it },
      ),
    )
    assertFalse(read)
    tasks.removeFirst().run()
    assertTrue(read)
    assertEquals(listOf("late"), discarded)
  }

  @Test
  fun `worker uses executor and handles rejection without running on caller`() {
    val immediate = WorkerWindowReadExecutor(Executor { it.run() })
    assertEquals(WindowReadResult.Completed(42), immediate.read(0, { 42 }, {}))
    val saturated = WorkerWindowReadExecutor(Executor { throw RejectedExecutionException("full") })
    var cleanups = 0
    val limited = QuarantiningWindowReadGuard(saturated, nowMs = { 0 })
    val result = limited.read(1, { error("must not run") }, { cleanups += 1 })
    assertEquals(WindowReadResult.Skipped("worker_unavailable"), result)
    assertEquals(1, cleanups)
  }
}
