package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeRefreshCoalescerTest {
  @Test
  fun `queued burst runs once and a request after completion runs again`() = runTest {
    val jobs = ArrayDeque<suspend () -> Unit>()
    var runs = 0
    val coalescer = PrototypeRefreshCoalescer({ jobs.addLast(it) }, { runs++ })
    repeat(100) { coalescer.request() }
    assertEquals(1, jobs.size)
    jobs.removeFirst()()
    assertEquals(1, runs)
    coalescer.request()
    assertEquals(1, jobs.size)
    jobs.removeFirst()()
    assertEquals(2, runs)
    assertEquals(0, jobs.size)
  }

  @Test
  fun `requests during a suspended action queue exactly one trailing run`() = runTest {
    val jobs = ArrayDeque<suspend () -> Unit>()
    val gate = CompletableDeferred<Unit>()
    var runs = 0
    val coalescer =
      PrototypeRefreshCoalescer(
        { jobs.addLast(it) },
        {
          runs++
          if (runs == 1) gate.await()
        },
      )
    coalescer.request()
    val first = launch { jobs.removeFirst()() }
    runCurrent()
    assertEquals(1, runs)
    repeat(100) { coalescer.request() }
    assertEquals(1, jobs.size)
    gate.complete(Unit)
    first.join()
    jobs.removeFirst()()
    assertEquals(2, runs)
    assertEquals(0, jobs.size)
  }
}
