package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeTimerControllerTest {
  private val host = FakePrototypeHost()
  private val idle = FakePrototypeTimer()
  private val events = mutableListOf<PrototypeEvent>()
  private val statuses = mutableListOf<List<PrototypeStatusEntry>>()
  private val results = mutableListOf<Boolean>()
  private val fired = mutableListOf<Int>()
  private var blocked = false
  private val spec =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "Timer"),
    )

  private fun TestScope.controller() =
    PrototypeController(
      host,
      object : PrototypeResultSink {
        override suspend fun send(requestId: String?, success: Boolean, error: String?) {
          results += success
        }

        override suspend fun sendAdvanced(requestId: String?, fired: Int) {
          this@PrototypeTimerControllerTest.fired += fired
        }

        override suspend fun sendPrototypeStatus(
          requestId: String?,
          prototypes: List<PrototypeStatusEntry>,
          droppedEvents: Long,
        ) {
          statuses += prototypes
        }
      },
      eventSink = PrototypeEventSink { events += it },
      clock = { testScheduler.currentTime },
      lifecycle = PrototypeLifecycle(idle, 500, isBlocked = { blocked }),
      render = { mapPrototypeSpec(it).request() },
      requestScope = backgroundScope,
    )

  private suspend fun PrototypeController.start(): PrototypeRuntime {
    show("show", spec)
    val runtime = checkNotNull(activeRuntime)
    interact(
      runtime,
      PrototypeInteraction.Tap(
        listOf(
          PrototypeStartTimerAction(
            "a",
            100,
            100,
            actions = listOf(PrototypeEmitAction("tick")),
          ),
        ),
      ),
    )
    return runtime
  }

  @Test
  fun `dismiss and replacing show cancel timers without handover`() = runTest {
    val controller = controller()
    val first = controller.start()
    controller.show("replace", spec)
    assertTrue(first.timerReports().isEmpty())
    assertTrue(checkNotNull(controller.activeRuntime).timerReports().isEmpty())
    val second = controller.start()
    controller.dismiss("dismiss", "panel", false)
    assertTrue(second.timerReports().isEmpty())
    advanceTimeBy(1000)
    runCurrent()
    assertTrue(events.none { it.name == "tick" })
  }

  @Test
  fun `scheduled fire never restarts idle TTL and expiry cancels timers`() = runTest {
    val controller = controller()
    val runtime = controller.start()
    val armed = idle.tasks.size
    runCurrent()
    advanceTimeBy(100)
    runCurrent()
    assertEquals(1, events.count { it.name == "tick" })
    assertEquals(armed, idle.tasks.size)
    idle.advance(500)
    assertFalse(runtime.current.active)
    assertTrue(runtime.timerReports().isEmpty())
  }

  @Test
  fun `hide freezes inspect remaining resume and advance use completion path`() = runTest {
    val controller = controller()
    controller.start()
    runCurrent()
    advanceTimeBy(40)
    blocked = true
    controller.onConfigurationChanged()
    advanceTimeBy(1000)
    controller.inspect("inspect")
    assertEquals(PrototypeTimerReport("a", 60, 0), statuses.last().single().timers.single())
    controller.advanceClock("paused", "panel", 500)
    assertEquals(0, fired.last())
    blocked = false
    controller.onConfigurationChanged()
    val armed = idle.tasks.size
    controller.advanceClock("advance", "panel", 160)
    assertEquals(2, fired.last())
    assertEquals(armed, idle.tasks.size)
    controller.inspect("inspect")
    assertEquals(PrototypeTimerReport("a", 100, 2), statuses.last().single().timers.single())
  }

  @Test
  fun `advance rejects unknown prototype and invalid duration`() = runTest {
    val controller = controller()
    controller.start()
    controller.advanceClock("unknown", "missing", 100)
    assertFalse(results.last())
    controller.advanceClock("invalid", "panel", 0)
    assertFalse(results.last())
  }
}
