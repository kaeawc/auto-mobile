package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.View
import androidx.compose.ui.platform.ComposeView
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Records frame waits; [gate] holds them open, [never] makes them outlast any timeout. */
private class FakeOverlayFrameWaiter(private val history: MutableList<String>) :
  OverlayFrameWaiter {
  var gate: CompletableDeferred<Unit>? = null
  var never = false

  override suspend fun awaitFrames(count: Int) {
    history += "frames:$count"
    gate?.await()
    if (never) awaitCancellation()
  }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayHideForCaptureTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmRuntime() {
      runTest {}
      InteractiveOverlayRequest()
    }
  }

  private val history = mutableListOf<String>()
  private lateinit var main: FakeOverlayMainThread
  private lateinit var manager: RecordingOverlayWindowManager
  private lateinit var frames: FakeOverlayFrameWaiter
  private lateinit var host: InteractiveOverlayHost
  private var blocked = false

  @Before
  fun setUp() {
    history.clear()
    blocked = false
    main = FakeOverlayMainThread()
    manager = RecordingOverlayWindowManager(main, history)
    frames = FakeOverlayFrameWaiter(history)
    host =
      DefaultInteractiveOverlayHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = FakeOverlaySettleTimer(history),
        backScope = CoroutineScope(Dispatchers.Unconfined),
        frames = frames,
        isBlocked = { blocked },
      )
    ComposeView(RuntimeEnvironment.getApplication())
  }

  private fun visibility(): String =
    if (manager.view!!.visibility == View.VISIBLE) "visible" else "hidden"

  @Test
  fun `hides, waits for frames, captures, then restores`() = runTest {
    host.show()
    history.clear()
    val capture = host.withHiddenForCapture {
      history += "capture:${visibility()}"
      "pixels"
    }
    assertEquals(listOf("frames:2", "capture:hidden"), history)
    assertEquals(OverlayHiddenCapture("pixels", overlayExcluded = true), capture)
    assertEquals(View.VISIBLE, manager.view!!.visibility)
    // Visibility only: the window's layout params and attachment are untouched.
    assertTrue(manager.updated.isEmpty())
    assertEquals(0, manager.removals)
  }

  @Test
  fun `restores when the capture fails`() = runTest {
    host.show()
    val error = runCatching {
      host.withHiddenForCapture { error("capture failed") }
    }
      .exceptionOrNull()
    assertEquals("capture failed", error?.message)
    assertEquals(View.VISIBLE, manager.view!!.visibility)
  }

  @Test
  fun `restores when the caller is cancelled while hidden`() = runTest {
    host.show()
    val started = CompletableDeferred<Unit>()
    val job =
      async(start = CoroutineStart.UNDISPATCHED) {
        host.withHiddenForCapture {
          started.complete(Unit)
          awaitCancellation()
        }
      }
    started.await()
    assertEquals(View.INVISIBLE, manager.view!!.visibility)
    job.cancel()
    runCatching { job.await() }
    assertEquals(View.VISIBLE, manager.view!!.visibility)
  }

  @Test
  fun `restores when cancelled during the frame wait`() = runTest {
    host.show()
    frames.gate = CompletableDeferred()
    var captured = false
    val job =
      async(start = CoroutineStart.UNDISPATCHED) { host.withHiddenForCapture { captured = true } }
    assertEquals(View.INVISIBLE, manager.view!!.visibility)
    job.cancel()
    runCatching { job.await() }
    assertFalse(captured)
    assertEquals(View.VISIBLE, manager.view!!.visibility)
  }

  @Test
  fun `unconfirmed hide still captures but reports the overlay may be included`() = runTest {
    host.show()
    frames.never = true
    val capture = host.withHiddenForCapture(frameTimeoutMillis = 50) { "capture:${visibility()}" }
    assertEquals(OverlayHiddenCapture("capture:hidden", overlayExcluded = false), capture)
    assertEquals(View.VISIBLE, manager.view!!.visibility)
  }

  @Test
  fun `a capture past the hidden bound is cancelled and the overlay restored`() = runTest {
    host.show()
    val error = runCatching {
      host.withHiddenForCapture(maxHiddenMillis = 100) { awaitCancellation() }
    }
      .exceptionOrNull()
    assertTrue(error is IllegalStateException)
    assertEquals(View.VISIBLE, manager.view!!.visibility)
  }

  @Test
  fun `without a window the capture runs as is and excludes no overlay`() = runTest {
    val capture = host.withHiddenForCapture { "pixels" }
    assertEquals(OverlayHiddenCapture("pixels", overlayExcluded = true), capture)
    assertTrue(history.none { it.startsWith("frames") })
  }

  @Test
  fun `hide and restore post to main when called off it`() = runTest {
    host.show()
    main.onMain = false
    val job =
      async(start = CoroutineStart.UNDISPATCHED) { host.withHiddenForCapture { visibility() } }
    assertEquals(View.VISIBLE, manager.view!!.visibility)
    main.drain()
    // The hide ran on main; the capture then posts the restore.
    testScheduler.runCurrent()
    main.drain()
    assertEquals(OverlayHiddenCapture("hidden", overlayExcluded = true), job.await())
    assertEquals(View.VISIBLE, manager.view!!.visibility)
  }

  @Test
  fun `a restore never re-shows an overlay blocked during the capture`() = runTest {
    host.show()
    val view = manager.view!!
    // Suspension (its app left the front) or the lock screen lands while the overlay is hidden.
    host.withHiddenForCapture { blocked = true }
    assertEquals(View.INVISIBLE, view.visibility)
    assertFalse(host.isShowing)
    assertEquals(1, manager.removals)
  }

  @Test
  fun `a suspended overlay has no window, so the capture treats it as not showing`() = runTest {
    host.show()
    blocked = true
    assertTrue(host.relayout()) // the suspension path removes the window
    history.clear()
    val capture = host.withHiddenForCapture { "pixels" }
    assertEquals(OverlayHiddenCapture("pixels", overlayExcluded = true), capture)
    assertTrue(history.none { it.startsWith("frames") })
    assertFalse(host.isShowing)
  }
}
