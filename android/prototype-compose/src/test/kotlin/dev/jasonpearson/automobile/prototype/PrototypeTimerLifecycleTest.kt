package dev.jasonpearson.automobile.prototype

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import dev.jasonpearson.automobile.ctrlproxy.prototype.InternalAutoMobilePrototypeApi
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeInteraction
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class, InternalAutoMobilePrototypeApi::class)
class PrototypeTimerLifecycleTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  @Test
  fun `host stop and start freeze timers under the interaction lock`() = runTest {
    val runtime =
      PrototypeRuntime(
        PrototypeSpec(
          "timer",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          root = PrototypeTextNode(text = "tick"),
        ),
        clock = { testScheduler.currentTime },
        nextSequence = { 1L },
        requestScope = backgroundScope,
      )
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypeStartTimerAction(
            "tick",
            200,
            actions = listOf(PrototypeEmitAction("tick")),
          ),
        ),
      ),
    )
    val owner =
      object : LifecycleOwner {
        override val lifecycle = LifecycleRegistry.createUnsafe(this)
      }
    val interactions = Mutex()
    val observer = prototypeTimerLifecycleObserver(backgroundScope, interactions) { runtime }
    interactions.lock()
    observer.onStateChanged(owner, Lifecycle.Event.ON_STOP)
    assertEquals(0, runtime.advanceClock(1))
    assertEquals(199L, runtime.timerReports().single().nextFireInMs)
    interactions.unlock()
    runCurrent()
    testScheduler.advanceTimeBy(1000)
    assertEquals(0, runtime.advanceClock(1000))
    assertEquals(199L, runtime.timerReports().single().nextFireInMs)
    observer.onStateChanged(owner, Lifecycle.Event.ON_START)
    runCurrent()
    assertEquals(0, runtime.advanceClock(198))
    assertEquals(1, runtime.advanceClock(1))
    runtime.close()
  }
}
