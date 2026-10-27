package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.WindowManager.LayoutParams
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypeWindowExitTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmHost() {
      runTest {}
      PrototypeRequest()
    }
  }

  @Test
  fun `dismiss passes touches through and detaches at timer deadline`() = runTest {
    val history = mutableListOf<String>()
    val main = FakePrototypeMainThread()
    val manager = RecordingPrototypeWindowManager(main, history)
    val timer = FakePrototypeSettleTimer(history).apply { gate = CompletableDeferred() }
    val host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = timer,
        backScope = backgroundScope,
        isViewAttached = manager::isViewAttached,
      )
    val activity = PrototypeMotionActivity()
    assertTrue(host.show(PrototypeRequest(transition = "fade", motionActivity = activity)))
    assertTrue(host.dismiss())
    testScheduler.runCurrent()
    assertFalse(host.isShowing)
    assertEquals(1, activity.snapshot().active)
    assertEquals(0, manager.removals)
    assertEquals(listOf(400L), timer.waits)
    assertTrue(manager.updated.last().flags and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
    timer.gate!!.complete(Unit)
    testScheduler.runCurrent()
    assertEquals(1, manager.removals)
    assertEquals(0, activity.snapshot().active)
  }

  @Test
  fun `none and immediate teardown bypass the exit timer`() = runTest {
    val history = mutableListOf<String>()
    val main = FakePrototypeMainThread()
    val manager = RecordingPrototypeWindowManager(main, history)
    val timer = FakePrototypeSettleTimer(history)
    val host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = timer,
        backScope = backgroundScope,
        isViewAttached = manager::isViewAttached,
      )
    host.show(PrototypeRequest(transition = "scale", motion = "none"))
    assertTrue(host.dismiss())
    host.show(PrototypeRequest(transition = "fade"))
    assertTrue(host.dismissImmediately())
    assertEquals(2, manager.removals)
    assertTrue(timer.waits.isEmpty())
  }

  @Test
  fun `destroy drains a pending exit once even when timer resumes`() = runTest {
    val history = mutableListOf<String>()
    val main = FakePrototypeMainThread()
    val manager = RecordingPrototypeWindowManager(main, history)
    val timer = FakePrototypeSettleTimer(history).apply { gate = CompletableDeferred() }
    val host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = timer,
        backScope = backgroundScope,
        isViewAttached = manager::isViewAttached,
      )
    host.show(PrototypeRequest(transition = "fade"))
    host.dismiss()
    testScheduler.runCurrent()
    host.destroy()
    assertEquals(1, manager.removals)
    timer.gate!!.complete(Unit)
    testScheduler.runCurrent()
    assertEquals(1, manager.removals)
  }

  @Test
  fun `replacing show leaves the new window attached while the old one exits`() = runTest {
    val history = mutableListOf<String>()
    val main = FakePrototypeMainThread()
    val manager = RecordingPrototypeWindowManager(main, history)
    val timer = FakePrototypeSettleTimer(history).apply { gate = CompletableDeferred() }
    val host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = timer,
        backScope = backgroundScope,
        isViewAttached = manager::isViewAttached,
      )
    host.show(PrototypeRequest(transition = "fade"))
    val old = manager.view
    host.replace(PrototypeRequest(transition = "fade", bringToFront = true))
    assertTrue(host.isShowing)
    assertNotSame(old, manager.view)
    assertEquals(0, manager.removals)
    assertEquals(listOf(400L), timer.waits)
    timer.gate!!.complete(Unit)
    testScheduler.runCurrent()
    assertEquals(1, manager.removals)
    assertTrue(host.isShowing)
    host.dismissImmediately()
    assertEquals(2, manager.removals)
  }
}
