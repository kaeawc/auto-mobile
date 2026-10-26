package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeTimersRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val events = mutableListOf<PrototypeEvent>()
  private val warnings = mutableListOf<String>()
  private var sequence = 0L
  private val spec =
    PrototypeSpec(
      "timer",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeSliderNode(stateKey = "n", min = 0.0, max = 10.0),
      state = mapOf("n" to PrototypeScalar.Numeric(0.0)),
    )

  private fun TestScope.runtime() =
    PrototypeRuntime(
      spec,
      PrototypeEventSink { events += it },
      { testScheduler.currentTime },
      { ++sequence },
      warn = { warnings += it },
      requestScope = backgroundScope,
    )

  private fun timer(
    id: String,
    after: Int = 100,
    period: Int? = null,
    max: Int? = null,
    actions: List<PrototypeAction> = listOf(PrototypeEmitAction(id)),
  ) = PrototypeStartTimerAction(id, after, period, max, actions)

  private suspend fun PrototypeRuntime.act(vararg actions: PrototypeAction) =
    handle(PrototypeInteraction.Tap(actions.toList()))

  private fun names() =
    events.filter { it.kind == PrototypeEventKind.EMIT && it.name != "change" }.map { it.name }

  @Test
  fun `advance orders chronologically with ties by start order`() = runTest {
    val runtime = runtime()
    runtime.act(timer("late", 300), timer("first", 100), timer("second", 100))
    assertEquals(3, runtime.advanceClock(300))
    assertEquals(listOf("first", "second", "late"), names())
    assertTrue(runtime.timerReports().isEmpty())
  }

  @Test
  fun `period uses planned time and maxRuns includes first fire`() = runTest {
    val runtime = runtime()
    runtime.act(timer("repeat", 100, 200, 3))
    assertEquals(2, runtime.advanceClock(300))
    assertEquals(PrototypeTimerReport("repeat", 200, 2), runtime.timerReports().single())
    assertEquals(1, runtime.advanceClock(1000))
    assertTrue(runtime.timerReports().isEmpty())
  }

  @Test
  fun `restart replaces schedule and resets runs and cancel is a no-op for unknown ids`() =
    runTest {
      val runtime = runtime()
      runtime.act(timer("a", period = 100))
      runtime.advanceClock(100)
      runtime.act(timer("a", 300))
      assertEquals(PrototypeTimerReport("a", 300, 0), runtime.timerReports().single())
      runtime.act(PrototypeCancelTimerAction("unknown"), PrototypeCancelTimerAction("a"))
      assertEquals(0, runtime.advanceClock(500))
    }

  @Test
  fun `a repeating timer can cancel itself`() = runTest {
    val runtime = runtime()
    runtime.act(timer("a", period = 100, actions = listOf(PrototypeCancelTimerAction("a"))))
    assertEquals(1, runtime.advanceClock(1000))
    assertTrue(runtime.timerReports().isEmpty())
  }

  @Test
  fun `nested start is measured from fire time and replacement wins`() = runTest {
    val runtime = runtime()
    runtime.act(timer("a", period = 100, actions = listOf(timer("a", 200), timer("b", 100))))
    assertEquals(3, runtime.advanceClock(300))
    assertEquals(listOf("b", "a"), names())
  }

  @Test
  fun `invalid state write drops whole fire while counting run`() = runTest {
    val runtime = runtime()
    runtime.act(
      timer(
        "a",
        period = 100,
        max = 2,
        actions =
          listOf(
            PrototypeEmitAction("must-not-fire"),
            PrototypeSetStateAction("n", PrototypeScalar.Text("wrong type")),
          ),
      ),
    )
    assertEquals(1, runtime.advanceClock(100))
    assertTrue(events.isEmpty())
    assertEquals(1, runtime.timerReports().single().runs)
    assertEquals(PrototypeScalar.Numeric(0.0), runtime.current.state["n"])
    assertEquals(1, warnings.size)
  }

  @Test
  fun `one fire emits a single change carrying final state`() = runTest {
    val runtime = runtime()
    runtime.act(
      timer(
        "a",
        actions =
          listOf(
            PrototypeIncrementAction("n"),
            PrototypeIncrementAction("n"),
          ),
      ),
    )
    runtime.advanceClock(100)
    assertEquals(1, events.count { it.name == "change" })
    assertEquals(PrototypeScalar.Numeric(2.0), runtime.current.state["n"])
  }

  @Test
  fun `dismiss in a fire cancels all timers`() = runTest {
    val runtime = runtime()
    runtime.act(timer("a", actions = listOf(PrototypeDismissAction)), timer("b", 200))
    assertEquals(1, runtime.advanceClock(1000))
    assertFalse(runtime.current.active)
    assertTrue(runtime.timerReports().isEmpty())
    assertTrue(names().isEmpty())
  }

  @Test
  fun `pause freezes remaining and resume continues on virtual scope`() = runTest {
    val runtime = runtime()
    runtime.act(timer("a", 200))
    runCurrent()
    advanceTimeBy(50)
    runtime.pauseTimers()
    advanceTimeBy(1000)
    assertEquals(0, runtime.advanceClock(1000))
    assertEquals(150L, runtime.timerReports().single().nextFireInMs)
    runtime.resumeTimers()
    runCurrent()
    advanceTimeBy(149)
    runCurrent()
    assertTrue(events.isEmpty())
    advanceTimeBy(1)
    runCurrent()
    assertEquals(listOf("a"), names())
  }

  @Test
  fun `advance shifts real scheduling and close cancels it`() = runTest {
    val runtime = runtime()
    runtime.act(timer("a", 300, 100))
    assertEquals(0, runtime.advanceClock(200))
    runCurrent()
    advanceTimeBy(100)
    runCurrent()
    assertEquals(listOf("a"), names())
    runtime.close()
    advanceTimeBy(1000)
    runCurrent()
    assertEquals(listOf("a"), names())
  }

  @Test
  fun `ninth live timer is refused but replacement is allowed`() = runTest {
    val runtime = runtime()
    runtime.act(*(0..8).map { timer("$it") }.toTypedArray())
    assertEquals(8, runtime.timerReports().size)
    runtime.act(timer("0", 200))
    assertEquals(8, runtime.timerReports().size)
    assertEquals("0", runtime.timerReports().last().id)
  }

  @Test
  fun `advance refuses more than ten thousand fires`() = runTest {
    var fires = 0
    val engine =
      PrototypeTimers({ testScheduler.currentTime }, backgroundScope, { it() }) { fires++ }
    engine.start(timer("a", period = 100))
    try {
      engine.advance(1_000_100)
      fail("Expected fire limit")
    } catch (error: IllegalStateException) {
      assertTrue(error.message.orEmpty().contains("10000"))
    }
    assertEquals(10000, fires)
    engine.cancelAll()
  }
}
