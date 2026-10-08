package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.WindowManager
import androidx.compose.ui.platform.ComposeView
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The host attaches to the requested display's own window manager, or fails without a window. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayDisplayHostTest {
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
  private lateinit var defaultManager: RecordingOverlayWindowManager
  private lateinit var displays: FakeOverlayDisplays
  private lateinit var host: InteractiveOverlayHost
  private var lost = 0

  @Before
  fun setUp() {
    history.clear()
    lost = 0
    main = FakeOverlayMainThread()
    defaultManager = RecordingOverlayWindowManager(main, history)
    displays = FakeOverlayDisplays(main, history, RuntimeEnvironment.getApplication())
    host =
      DefaultInteractiveOverlayHost(
        RuntimeEnvironment.getApplication(),
        defaultManager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = FakeOverlaySettleTimer(history),
        densityProvider = { 2.5f },
        onWindowLost = { lost++ },
        displayWindows = displays,
      )
    ComposeView(RuntimeEnvironment.getApplication())
  }

  private fun sheet(displayId: Int) =
    InteractiveOverlayRequest(
      OverlayPlacement.Sheet(OverlayPlacement.Edge.BOTTOM, 20f),
      displayId = displayId,
    )

  @Test
  fun `default display keeps the service window manager and never opens a display context`() =
    runTest {
      assertTrue(host.show(sheet(0)))
      assertEquals(1, defaultManager.added.size)
      assertEquals(50, defaultManager.added.single().height) // 20dp at the service's 2.5 density
      assertTrue(displays.opened.isEmpty())
    }

  @Test
  fun `requested display attaches to its own window manager with its own density`() = runTest {
    val inner = displays.connect(2, density = 3f)
    assertTrue(host.show(sheet(2)))
    assertTrue(defaultManager.added.isEmpty())
    assertEquals(1, inner.added.size)
    assertEquals(60, inner.added.single().height) // 20dp at the inner display's 3.0 density
    assertTrue(host.isShowing)
  }

  @Test
  fun `unknown display throws and attaches nothing`() = runTest {
    val error = runCatching { host.show(sheet(7)) }.exceptionOrNull()
    assertTrue(error is IllegalArgumentException)
    assertEquals("Unknown or disconnected display: 7", error?.message)
    assertFalse(host.isShowing)
    assertTrue(defaultManager.added.isEmpty())
  }

  @Test
  fun `unknown display leaves the overlay already shown untouched`() = runTest {
    assertTrue(host.show(sheet(0)))
    assertTrue(runCatching { host.show(sheet(7)) }.exceptionOrNull() is IllegalArgumentException)
    assertTrue(host.isShowing)
    assertEquals(0, defaultManager.removals)
  }

  @Test
  fun `relayout touch-through and dismiss all use the window's own display`() = runTest {
    val inner = displays.connect(2)
    host.show(sheet(2))
    host.withTouchThrough { assertTrue(host.relayout()) }
    assertTrue(inner.updated.isNotEmpty())
    assertTrue(defaultManager.updated.isEmpty())
    assertTrue(host.dismiss())
    assertEquals(1, inner.removals)
    assertEquals(0, defaultManager.removals)
    assertFalse(host.isShowing)
  }

  @Test
  fun `same display replace updates in place without a second window`() = runTest {
    val inner = displays.connect(2)
    host.show(sheet(2))
    assertTrue(host.replace(sheet(2)))
    assertEquals(1, inner.added.size)
    assertEquals(1, inner.updated.size)
    assertEquals(listOf(2), displays.opened) // the in-place update reuses the window's target
  }

  @Test
  fun `repeated same display updates open the display window context once`() = runTest {
    val inner = displays.connect(2)
    host.show(sheet(2))
    repeat(3) { assertTrue(host.replace(sheet(2))) }
    assertEquals(listOf(2), displays.opened)
    assertEquals(1, inner.added.size)
    assertEquals(3, inner.updated.size)
  }

  @Test
  fun `moving to another display attaches the new window before removing the old one`() = runTest {
    val inner = displays.connect(2)
    host.show(sheet(0))
    history.clear()
    assertTrue(host.replace(sheet(2)))
    assertEquals(listOf("add", "remove"), history)
    assertEquals(1, inner.added.size)
    assertEquals(1, defaultManager.removals)
    assertTrue(host.isShowing)
    assertEquals(OverlayPlacement.Sheet(OverlayPlacement.Edge.BOTTOM, 20f), host.currentPlacement)
    // The retained window is the new one: dismiss removes it from display 2.
    assertTrue(host.dismiss())
    assertEquals(1, inner.removals)
    assertEquals(1, defaultManager.removals)
  }

  @Test
  fun `a failed add on the new display keeps the old overlay`() = runTest {
    val inner = displays.connect(2)
    inner.failAdd = true
    host.show(sheet(0))
    assertFalse(host.replace(sheet(2)))
    assertTrue(host.isShowing)
    assertEquals(0, defaultManager.removals)
    assertTrue(host.dismiss())
    assertEquals(1, defaultManager.removals)
  }

  @Test
  fun `a window the removed display took with it is cleared and reported lost`() = runTest {
    val inner = displays.connect(2)
    host.show(sheet(2))
    inner.failUpdate = true
    inner.updateFailure = IllegalArgumentException("View not attached to window manager")
    assertFalse(host.relayout())
    assertFalse(host.isShowing)
    assertEquals(1, lost)
  }

  @Test
  fun `app layer windows use the application overlay type on the default display`() = runTest {
    assertTrue(host.show(sheet(0).copy(layer = OverlayWindowLayer.APP)))
    assertEquals(
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      defaultManager.added.single().type,
    )
    assertTrue(host.show(sheet(0)))
    // A window's type cannot change after add: the system layer attaches a fresh window.
    assertEquals(
      listOf(
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
      ),
      defaultManager.added.map { it.type },
    )
    assertEquals(1, defaultManager.removals)
    assertTrue(defaultManager.updated.isEmpty())
  }

  @Test
  fun `secondary display contexts are created for the requested layer`() = runTest {
    val inner = displays.connect(2)
    assertTrue(host.show(sheet(2).copy(layer = OverlayWindowLayer.APP)))
    assertTrue(host.replace(sheet(2).copy(layer = OverlayWindowLayer.APP)))
    assertTrue(host.replace(sheet(2)))
    assertEquals(listOf(OverlayWindowLayer.APP, OverlayWindowLayer.SYSTEM), displays.openedLayers)
    assertEquals(
      listOf(
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
      ),
      inner.added.map { it.type },
    )
    assertEquals(
      WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
      inner.updated.single().type,
    )
  }

  @Test
  fun `negative display ids are rejected when the request is built`() {
    assertThrows(IllegalArgumentException::class.java) {
      InteractiveOverlayRequest(displayId = -1)
    }
  }
}
