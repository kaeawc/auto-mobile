package dev.jasonpearson.automobile.prototype.appshell

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import org.junit.Assert.assertEquals
import org.junit.Test

class ResumedRemountGateTest {
  private val owner =
    object : LifecycleOwner {
      override val lifecycle: Lifecycle
        get() = registry
    }
  private val registry = LifecycleRegistry.createUnsafe(owner)
  private var onAppearRuns = 0
  private val gate = ResumedRemountGate { onAppearRuns++ }

  init {
    registry.addObserver(gate)
    registry.currentState = Lifecycle.State.RESUMED
  }

  @Test
  fun `authored dismissal does not run onAppear while the task is backgrounding`() {
    gate.requestAfterBackgrounding()
    assertEquals(0, onAppearRuns)

    registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
    registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
    assertEquals(0, onAppearRuns)

    registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
    assertEquals(0, onAppearRuns)

    registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
    assertEquals(1, onAppearRuns)
  }

  @Test
  fun `remount runs once per dismissal`() {
    gate.requestAfterBackgrounding()
    registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
    registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
    registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
    registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
    assertEquals(1, onAppearRuns)
  }

  @Test
  fun `resuming without a dismissal does not remount`() {
    registry.handleLifecycleEvent(Lifecycle.Event.ON_PAUSE)
    registry.handleLifecycleEvent(Lifecycle.Event.ON_STOP)
    registry.handleLifecycleEvent(Lifecycle.Event.ON_START)
    registry.handleLifecycleEvent(Lifecycle.Event.ON_RESUME)
    assertEquals(0, onAppearRuns)
  }
}
