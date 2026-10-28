package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.view.WindowManager.LayoutParams
import kotlinx.coroutines.*
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Before
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

  private val scope = TestScope()
  private lateinit var manager: RecordingPrototypeWindowManager
  private lateinit var timer: FakePrototypeSettleTimer
  private lateinit var host: PrototypeHost
  private var lost = 0

  @Before
  fun setUp() {
    val history = mutableListOf<String>()
    val main = FakePrototypeMainThread()
    manager = RecordingPrototypeWindowManager(main, history)
    timer = FakePrototypeSettleTimer(history).apply { gate = CompletableDeferred() }
    host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        firstRenderWaiter = PrototypeFirstRenderWaiter { _, _ -> true },
        mainThread = main,
        settleTimer = timer,
        backScope = scope.backgroundScope,
        isViewAttached = manager::isViewAttached,
        onWindowLost = { lost++ },
      )
  }

  @Test
  fun `dismiss passes touches through and detaches at timer deadline`() = scope.runTest {
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
  fun `none and immediate teardown bypass the exit timer`() = scope.runTest {
    host.show(PrototypeRequest(transition = "scale", motion = "none"))
    assertTrue(host.dismiss())
    host.show(PrototypeRequest(transition = "fade"))
    assertTrue(host.dismissImmediately())
    assertEquals(2, manager.removals)
    assertTrue(timer.waits.isEmpty())
  }

  @Test
  fun `destroy drains a pending exit once even when timer resumes`() = scope.runTest {
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
  fun `replacing show leaves the new window attached while the old one exits`() = scope.runTest {
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

  @Test
  fun `animated dismissal of an already detached window succeeds and clears ownership`() =
    scope.runTest {
      val resources = PrototypeExitResources()
      val activity = PrototypeMotionActivity()
      host.show(
        PrototypeRequest(transition = "fade", exitResources = resources, motionActivity = activity),
      )
      manager.failUpdate = true
      manager.updateFailure = IllegalArgumentException("not attached")
      assertTrue(host.dismiss())
      assertFalse(host.isShowing)
      assertNull(host.currentPlacement)
      assertEquals(1, lost)
      assertEquals(0, resources.count(null))
      assertEquals(0, activity.snapshot().active)
      assertTrue(timer.waits.isEmpty())
    }

  @Test
  fun `ordinary update failure keeps dismissal retryable`() = scope.runTest {
    host.show(PrototypeRequest(transition = "fade"))
    manager.failUpdate = true
    assertFalse(host.dismiss())
    assertTrue(host.isShowing)
    assertEquals(0, lost)
    manager.failUpdate = false
    assertTrue(host.dismissImmediately())
  }

  @Test
  fun `motion none transition none and zero system scales preserve the attached window`() =
    scope.runTest {
      val resolver = RuntimeEnvironment.getApplication().contentResolver
      host.show(PrototypeRequest(transition = "fade"))
      val original = manager.view
      for (request in
        listOf(
          PrototypeRequest(transition = "none"),
          PrototypeRequest(transition = "fade", motion = "none"),
        )) {
        assertTrue(host.replace(request.copy(bringToFront = true)))
        assertSame(original, manager.view)
      }
      for (setting in
        listOf(
          android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
          android.provider.Settings.Global.TRANSITION_ANIMATION_SCALE,
        )) {
        android.provider.Settings.Global.putFloat(resolver, setting, 0f)
        assertTrue(host.replace(PrototypeRequest(transition = "fade", bringToFront = true)))
        assertSame(original, manager.view)
        android.provider.Settings.Global.putFloat(resolver, setting, 1f)
      }
      assertEquals(1, manager.added.size)
      assertEquals(0, manager.removals)
      host.dismissImmediately()
    }
}
