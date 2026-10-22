package dev.jasonpearson.automobile.protoviewer

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeScheduledTask
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeScheduler
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class RenderWatchdogTest {
  private val timer = FakeRenderTimer()
  private val watchdog = DeadlineRenderWatchdog { timer }

  @Test
  fun expiresOnlyAtNamedRenderBudget() = runBlocking {
    var failures = 0
    watchdog.start(this) { failures++ }
    timer.advanceBy(RENDER_READY_BUDGET_MILLIS - 1)
    assertEquals(0, failures)
    timer.advanceBy(1)
    assertEquals(1, failures)
    timer.advanceBy(RENDER_READY_BUDGET_MILLIS)
    assertEquals(1, failures)
  }

  @Test
  fun cancellationSuppressesEvenAlreadyQueuedExpiry() = runBlocking {
    var failures = 0
    val task = watchdog.start(this) { failures++ }
    val queued = timer.tasks.single().action
    task.cancel()
    queued()
    assertEquals(0, failures)
    assertTrue(timer.tasks.single().cancelled)
  }
}

internal class FakeRenderTimer : PrototypeScheduler {
  data class Task(
    val deadline: Long,
    val action: suspend () -> Unit,
    var cancelled: Boolean = false,
  )

  val tasks = mutableListOf<Task>()
  private var now = 0L

  override fun schedule(millis: Long, action: suspend () -> Unit): PrototypeScheduledTask {
    val task = Task(now + millis, action)
    tasks += task
    return PrototypeScheduledTask { task.cancelled = true }
  }

  fun advanceBy(millis: Long) {
    now += millis
    tasks
      .filter { !it.cancelled && it.deadline <= now }
      .forEach {
        it.cancelled = true
        runBlocking { it.action() }
      }
  }
}
