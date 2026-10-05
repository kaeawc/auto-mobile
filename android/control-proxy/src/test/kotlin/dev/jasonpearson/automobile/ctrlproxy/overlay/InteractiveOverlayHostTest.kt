package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.WindowManager.LayoutParams
import androidx.compose.ui.platform.ComposeView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.findViewTreeLifecycleOwner
import androidx.lifecycle.findViewTreeViewModelStoreOwner
import androidx.savedstate.findViewTreeSavedStateRegistryOwner
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class InteractiveOverlayHostTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmRuntime() {
      // Robolectric has no application before the first method; warm only coroutine machinery here.
      runTest {}
      InteractiveOverlayRequest()
    }
  }

  private val history = mutableListOf<String>()
  private lateinit var main: FakeOverlayMainThread
  private lateinit var timer: FakeOverlaySettleTimer
  private lateinit var manager: RecordingOverlayWindowManager
  private lateinit var host: InteractiveOverlayHost

  @Before
  fun setUp() {
    history.clear()
    main = FakeOverlayMainThread()
    timer = FakeOverlaySettleTimer(history)
    manager = RecordingOverlayWindowManager(main, history)
    host =
      DefaultInteractiveOverlayHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = timer,
        densityProvider = { 2.5f },
        onWindowAttached = { history += "hook" },
      )
    // Warm platform/Compose constructors outside test bodies; no window attaches or composition
    // runs.
    ComposeView(RuntimeEnvironment.getApplication())
  }

  @Test
  fun `show supplies all tree owners and attachment hook follows single add`() = runTest {
    assertTrue(host.show())
    val view = manager.view!!
    assertTrue(view is ComposeView)
    assertEquals(listOf("add", "hook"), history)
    assertEquals(
      Lifecycle.State.RESUMED,
      view.findViewTreeLifecycleOwner()!!.lifecycle.currentState,
    )
    assertNotNull(view.findViewTreeSavedStateRegistryOwner())
    assertNotNull(view.findViewTreeViewModelStoreOwner())
    assertTrue(host.isShowing)
    assertEquals(OverlayPlacement.Floating(), host.currentPlacement)
    assertEquals(LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, manager.added.single().type)
  }

  @Test
  fun `show while showing replaces content focus and placement without another add`() = runTest {
    host.show()
    val view = manager.view
    val owner = view!!.findViewTreeLifecycleOwner()
    val placement = OverlayPlacement.Sheet(OverlayPlacement.Edge.TOP, 20f)
    assertTrue(host.show(InteractiveOverlayRequest(placement, hasTextField = true)))
    assertSame(view, manager.view)
    assertSame(owner, view.findViewTreeLifecycleOwner())
    assertEquals(1, manager.added.size)
    assertEquals(1, manager.updated.size)
    assertEquals(50, manager.updated.last().height)
    assertFalse(manager.updated.last().flags and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
    assertEquals(placement, host.currentPlacement)
    assertTrue(host.replace(InteractiveOverlayRequest()))
    assertTrue(manager.updated.last().flags and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
    assertEquals(1, history.count { it == "hook" })
  }

  @Test
  fun `replace without a window shows it`() = runTest {
    assertTrue(host.replace(InteractiveOverlayRequest()))
    assertEquals(1, manager.added.size)
  }

  @Test
  fun `dismiss is idempotent destroys owner and subsequent show creates fresh owners`() = runTest {
    host.show()
    val oldView = manager.view!!
    val owner = oldView.findViewTreeLifecycleOwner()!!
    assertTrue(host.dismiss())
    assertTrue(host.dismiss())
    assertEquals(1, manager.removals)
    assertEquals(Lifecycle.State.DESTROYED, owner.lifecycle.currentState)
    assertFalse(host.isShowing)
    assertNull(host.currentPlacement)
    assertTrue(host.show())
    assertNotSame(oldView, manager.view)
    assertNotSame(owner, manager.view!!.findViewTreeLifecycleOwner())
  }

  @Test
  fun `destroy is terminal for show and replace and double destroy removes once`() = runTest {
    host.show()
    val owner = manager.view!!.findViewTreeLifecycleOwner()!!
    assertTrue(host.destroy())
    assertTrue(host.destroy())
    assertFalse(host.show())
    assertFalse(host.replace(InteractiveOverlayRequest()))
    assertEquals(1, manager.added.size)
    assertEquals(1, manager.removals)
    assertEquals(Lifecycle.State.DESTROYED, owner.lifecycle.currentState)
  }

  @Test
  fun `add failure returns false destroys owner has no stale state and skips hook`() = runTest {
    manager.failAdd = true
    assertFalse(host.show())
    val failed = manager.view!!
    assertEquals(
      Lifecycle.State.DESTROYED,
      failed.findViewTreeLifecycleOwner()!!.lifecycle.currentState,
    )
    assertFalse(host.isShowing)
    assertNull(host.currentPlacement)
    assertFalse(host.isTouchThroughActive)
    assertEquals(listOf("add"), history)
    assertTrue(host.dismiss())
    assertEquals(0, manager.removals)
    manager.failAdd = false
    assertTrue(host.show())
    assertNotSame(failed, manager.view)
  }

  @Test
  fun `replace update failure keeps the prior request and window`() = runTest {
    host.show()
    manager.failUpdate = true
    assertFalse(
      host.replace(InteractiveOverlayRequest(OverlayPlacement.Fullscreen(), opacityPercent = 40))
    )
    assertEquals(OverlayPlacement.Floating(), host.currentPlacement)
    assertEquals(1f, manager.view!!.alpha, 0f)
    assertEquals(1, manager.added.size)
  }

  @Test
  fun `failed removal can be retried even after terminal destroy`() = runTest {
    host.show()
    manager.failRemove = true
    assertFalse(host.destroy())
    assertTrue(host.isShowing)
    assertFalse(host.show())
    manager.failRemove = false
    assertTrue(host.dismiss())
    assertFalse(host.isShowing)
  }

  @Test
  fun `not attached dismissal clears active state and allows a fresh window`() = runTest {
    host.show()
    val oldView = manager.view!!
    val owner = oldView.findViewTreeLifecycleOwner()!!
    host.withTouchThrough {
      manager.failRemove = true
      manager.removeFailure = IllegalArgumentException("not attached")
      assertTrue(host.dismiss())
      assertFalse(host.isShowing)
      assertNull(host.currentPlacement)
      assertFalse(host.isTouchThroughActive)
      assertEquals(Lifecycle.State.DESTROYED, owner.lifecycle.currentState)
      assertTrue(host.show())
    }
    assertNotSame(oldView, manager.view)
    assertEquals(2, manager.added.size)
    assertEquals(2, history.count { it == "add" })
    assertEquals(1, manager.updated.size)
    assertTrue(host.isShowing)
    assertFalse(host.isTouchThroughActive)
  }

  @Test
  fun `not attached removal lets destroy succeed and clear state`() = runTest {
    host.show()
    val owner = manager.view!!.findViewTreeLifecycleOwner()!!
    manager.failRemove = true
    manager.removeFailure = IllegalArgumentException("not attached")
    assertTrue(host.destroy())
    assertTrue(host.destroy())
    assertFalse(host.isShowing)
    assertNull(host.currentPlacement)
    assertFalse(host.isTouchThroughActive)
    assertEquals(Lifecycle.State.DESTROYED, owner.lifecycle.currentState)
    assertFalse(host.show())
  }

  @Test
  fun `not attached update fails current show but allows a fresh window`() = runTest {
    host.show()
    val oldView = manager.view!!
    val owner = oldView.findViewTreeLifecycleOwner()!!
    manager.failUpdate = true
    manager.updateFailure = IllegalArgumentException("not attached")
    assertFalse(host.show(InteractiveOverlayRequest(OverlayPlacement.Fullscreen())))
    assertFalse(host.isShowing)
    assertNull(host.currentPlacement)
    assertFalse(host.isTouchThroughActive)
    assertEquals(Lifecycle.State.DESTROYED, owner.lifecycle.currentState)
    assertTrue(host.show())
    assertNotSame(oldView, manager.view)
    assertEquals(2, manager.added.size)
    assertTrue(host.isShowing)
  }

  @Test
  fun `not attached touch through activation clears window without running gesture`() = runTest {
    host.show()
    manager.failUpdate = true
    manager.updateFailure = IllegalArgumentException("not attached")
    var ran = false
    val error = runCatching { host.withTouchThrough { ran = true } }.exceptionOrNull()
    assertTrue(error is IllegalStateException)
    assertEquals("Failed to enable overlay touch-through", error!!.message)
    assertFalse(ran)
    assertFalse(host.isShowing)
    assertNull(host.currentPlacement)
    assertFalse(host.isTouchThroughActive)
    assertTrue(host.show())
    assertEquals(2, manager.added.size)
  }

  @Test
  fun `not attached touch through restoration clears window and active token`() = runTest {
    host.show()
    val owner = manager.view!!.findViewTreeLifecycleOwner()!!
    val error = runCatching {
      host.withTouchThrough {
        manager.failUpdate = true
        manager.updateFailure = IllegalArgumentException("not attached")
      }
    }
      .exceptionOrNull()
    assertTrue(error is IllegalStateException)
    assertEquals("Failed to restore overlay touchability", error!!.message)
    assertFalse(host.isShowing)
    assertNull(host.currentPlacement)
    assertFalse(host.isTouchThroughActive)
    assertEquals(Lifecycle.State.DESTROYED, owner.lifecycle.currentState)
    assertTrue(host.show())
    assertEquals(2, manager.added.size)
  }

  @Test
  fun `other removal failure keeps window placement and allows retry`() = runTest {
    host.show()
    val owner = manager.view!!.findViewTreeLifecycleOwner()!!
    manager.failRemove = true
    assertFalse(host.dismiss())
    assertTrue(host.isShowing)
    assertEquals(OverlayPlacement.Floating(), host.currentPlacement)
    assertEquals(Lifecycle.State.RESUMED, owner.lifecycle.currentState)
    manager.failRemove = false
    assertTrue(host.dismiss())
    assertFalse(host.isShowing)
  }

  @Test
  fun `opacity changes whole view with no window add remove or layout update`() = runTest {
    host.show(InteractiveOverlayRequest(opacityPercent = 70))
    assertEquals(0.7f, manager.view!!.alpha, 0f)
    host.setOpacity(0)
    assertEquals(0f, manager.view!!.alpha, 0f)
    host.setOpacity(100)
    assertEquals(1f, manager.view!!.alpha, 0f)
    host.setOpacity(25)
    assertEquals(0.25f, manager.view!!.alpha, 0f)
    assertEquals(1, manager.added.size)
    assertEquals(0, manager.updated.size)
    assertEquals(0, manager.removals)
  }

  @Test
  fun `opacity rejects invalid requests and setter values`() = runTest {
    assertThrows(IllegalArgumentException::class.java) {
      InteractiveOverlayRequest(opacityPercent = -1)
    }
    assertThrows(IllegalArgumentException::class.java) {
      InteractiveOverlayRequest(opacityPercent = 101)
    }
    for (percent in listOf(-1, 101)) {
      val error = runCatching { host.setOpacity(percent) }.exceptionOrNull()
      assertTrue(error is IllegalArgumentException)
      assertEquals("Opacity must be in 0..100", error!!.message)
    }
  }

  @Test
  fun `touch through waits before gesture restores in place and returns result`() = runTest {
    host.show()
    history.clear()
    val result = host.withTouchThrough {
      assertTrue(host.isTouchThroughActive)
      history += "block"
      42
    }
    assertEquals(42, result)
    assertEquals(listOf("untouchable", "settle:100", "block", "touchable"), history)
    assertFalse(host.isTouchThroughActive)
    assertEquals(1, manager.added.size)
    assertEquals(0, manager.removals)
    assertFalse(manager.updated.last().flags and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
  }

  @Test
  fun `touch through clamps short waits and honors longer waits`() = runTest {
    host.show()
    host.withTouchThrough(-5) {}
    host.withTouchThrough(16) {}
    host.withTouchThrough(50) {}
    host.withTouchThrough(250) {}
    assertEquals(listOf(100L, 100L, 100L, 250L), timer.waits)
  }

  @Test
  fun `without a window touch through calls block with no settle update or main post`() = runTest {
    main.onMain = false
    assertEquals("result", host.withTouchThrough { "result" })
    assertTrue(main.pending.isEmpty())
    assertTrue(history.isEmpty())
    assertTrue(timer.waits.isEmpty())
    assertFalse(host.isTouchThroughActive)
  }

  @Test
  fun `throwing gesture restores touchability and propagates original failure`() = runTest {
    host.show()
    val expected = IllegalStateException("gesture failed")
    val actual = runCatching { host.withTouchThrough<Unit> { throw expected } }.exceptionOrNull()
    assertSame(expected, actual)
    assertFalse(host.isTouchThroughActive)
    assertEquals("touchable", history.last())
  }

  @Test
  fun `cancellation inside gesture restores touchability`() = runTest {
    host.show()
    val gesture =
      launch(start = CoroutineStart.UNDISPATCHED) {
        host.withTouchThrough { awaitCancellation() }
      }
    assertTrue(host.isTouchThroughActive)
    gesture.cancelAndJoin()
    assertFalse(host.isTouchThroughActive)
    assertEquals("touchable", history.last())
  }

  @Test
  fun `cancellation during settle restores without running gesture`() = runTest {
    host.show()
    timer.gate = CompletableDeferred()
    var ran = false
    val gesture =
      launch(start = CoroutineStart.UNDISPATCHED) {
        host.withTouchThrough { ran = true }
      }
    gesture.cancelAndJoin()
    assertFalse(ran)
    assertFalse(host.isTouchThroughActive)
    assertEquals("touchable", history.last())
  }

  @Test
  fun `dismiss inside gesture makes restore a no op`() = runTest {
    host.show()
    host.withTouchThrough { host.dismiss() }
    assertEquals(1, manager.updated.size)
    assertEquals(1, manager.removals)
    assertFalse(host.isTouchThroughActive)
    assertFalse(host.isShowing)
  }

  @Test
  fun `dismiss then show during gesture never restores onto new window`() = runTest {
    host.show()
    host.withTouchThrough {
      host.dismiss()
      host.show()
    }
    assertEquals(1, manager.updated.size)
    assertEquals(2, manager.added.size)
    assertTrue(host.isShowing)
    assertFalse(host.isTouchThroughActive)
  }

  @Test
  fun `replace during gesture preserves touch through and restores the new params`() = runTest {
    host.show()
    host.withTouchThrough {
      host.replace(InteractiveOverlayRequest(hasTextField = true))
      assertTrue(host.isTouchThroughActive)
      assertTrue(manager.updated.last().flags and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
      assertFalse(manager.updated.last().flags and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
    }
    assertFalse(host.isTouchThroughActive)
    assertEquals(3, manager.updated.size)
    assertFalse(manager.updated.last().flags and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
    assertFalse(manager.updated.last().flags and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
    assertEquals(1, manager.added.size)
  }

  @Test
  fun `show during gesture restores new placement flags after the block`() = runTest {
    host.show()
    host.withTouchThrough {
      assertTrue(host.show(InteractiveOverlayRequest(OverlayPlacement.Fullscreen())))
      assertTrue(host.isTouchThroughActive)
      assertTrue(manager.updated.last().flags and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
    }
    assertFalse(host.isTouchThroughActive)
    assertFalse(manager.updated.last().flags and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
    assertEquals(LayoutParams.MATCH_PARENT, manager.updated.last().width)
    assertEquals(1, manager.added.size)
  }

  @Test
  fun `destroy during gesture invalidates restore and refuses future show`() = runTest {
    host.show()
    host.withTouchThrough { host.destroy() }
    assertEquals(1, manager.updated.size)
    assertFalse(host.isTouchThroughActive)
    assertFalse(host.show())
  }

  @Test
  fun `overlapping gestures serialize flags waits and blocks`() = runTest {
    host.show()
    history.clear()
    val release = CompletableDeferred<Unit>()
    val first =
      launch(start = CoroutineStart.UNDISPATCHED) {
        host.withTouchThrough {
          history += "first"
          release.await()
        }
      }
    val second =
      launch(start = CoroutineStart.UNDISPATCHED) {
        host.withTouchThrough { history += "second" }
      }
    assertEquals(listOf("untouchable", "settle:100", "first"), history)
    release.complete(Unit)
    first.join()
    second.join()
    assertEquals(
      listOf(
        "untouchable",
        "settle:100",
        "first",
        "touchable",
        "untouchable",
        "settle:100",
        "second",
        "touchable",
      ),
      history,
    )
  }

  @Test
  fun `all host mutations post off main and run inline on main`() = runTest {
    main.onMain = false
    val show = async(start = CoroutineStart.UNDISPATCHED) { host.show() }
    assertFalse(host.isShowing)
    assertEquals(1, main.pending.size)
    main.drain()
    assertTrue(show.await())
    val replace =
      async(start = CoroutineStart.UNDISPATCHED) {
        host.replace(InteractiveOverlayRequest(hasTextField = true))
      }
    assertTrue(manager.updated.isEmpty())
    main.drain()
    assertTrue(replace.await())
    val opacity = async(start = CoroutineStart.UNDISPATCHED) { host.setOpacity(50) }
    main.drain()
    opacity.await()
    assertEquals(0.5f, manager.view!!.alpha, 0f)
    val dismiss = async(start = CoroutineStart.UNDISPATCHED) { host.dismiss() }
    assertEquals(0, manager.removals)
    main.drain()
    assertTrue(dismiss.await())
    val destroy = async(start = CoroutineStart.UNDISPATCHED) { host.destroy() }
    main.drain()
    assertTrue(destroy.await())
    main.onMain = true
    assertFalse(host.show())
    assertTrue(main.pending.isEmpty())
  }

  @Test
  fun `failed touch through activation refuses to run gesture`() = runTest {
    host.show()
    manager.failUpdate = true
    var ran = false
    val error = runCatching { host.withTouchThrough { ran = true } }.exceptionOrNull()
    assertTrue(error is IllegalStateException)
    assertEquals("Failed to enable overlay touch-through", error!!.message)
    assertFalse(ran)
    assertFalse(host.isTouchThroughActive)
    assertTrue(timer.waits.isEmpty())
  }

  @Test
  fun `failed restoration reports failure and retains active state until dismissal`() = runTest {
    host.show()
    val error = runCatching {
      host.withTouchThrough { manager.failUpdate = true }
    }
      .exceptionOrNull()
    assertTrue(error is IllegalStateException)
    assertEquals("Failed to restore overlay touchability", error!!.message)
    assertTrue(host.isTouchThroughActive)
    host.dismiss()
    assertFalse(host.isTouchThroughActive)
  }

  @Test
  fun `failed dismissal during gesture still allows restoration`() = runTest {
    host.show()
    host.withTouchThrough {
      manager.failRemove = true
      assertFalse(host.dismiss())
      assertTrue(host.isTouchThroughActive)
    }
    assertFalse(host.isTouchThroughActive)
    assertTrue(host.isShowing)
    assertEquals("touchable", history.last())
  }

  @Test
  fun `cancellation before posted activation still restores without dispatching gesture`() =
    runTest {
      host.show()
      main.onMain = false
      var ran = false
      val gesture =
        launch(start = CoroutineStart.UNDISPATCHED) {
          host.withTouchThrough { ran = true }
        }
      gesture.cancel()
      main.drain()
      testScheduler.runCurrent()
      main.drain()
      gesture.join()
      assertFalse(ran)
      assertFalse(host.isTouchThroughActive)
      assertTrue(timer.waits.isEmpty())
      assertEquals("touchable", history.last())
    }

  @Test
  fun `destroy invalidates a restoration already posted to main`() = runTest {
    host.show()
    main.onMain = false
    val gesture =
      async(start = CoroutineStart.UNDISPATCHED) {
        host.withTouchThrough { "result" }
      }
    main.drain()
    testScheduler.runCurrent()
    assertEquals(1, main.pending.size)
    assertTrue(host.isTouchThroughActive)
    main.onMain = true
    host.destroy()
    main.drain()
    assertEquals("result", gesture.await())
    assertEquals(1, manager.updated.size)
    assertFalse(host.isTouchThroughActive)
    assertFalse(host.isShowing)
  }

  @Test
  fun `cancelled off main gesture still posts and completes restoration`() = runTest {
    host.show()
    main.onMain = false
    val gesture =
      launch(start = CoroutineStart.UNDISPATCHED) {
        host.withTouchThrough { awaitCancellation() }
      }
    main.drain()
    // Let the activation resume and reach its suspended block without advancing real time.
    testScheduler.runCurrent()
    assertTrue(host.isTouchThroughActive)
    gesture.cancel()
    testScheduler.runCurrent()
    assertEquals(1, main.pending.size)
    main.drain()
    gesture.join()
    assertFalse(host.isTouchThroughActive)
    assertEquals("touchable", history.last())
  }
}
