package dev.jasonpearson.automobile.ctrlproxy.prototype

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
class PrototypeDisplayHostTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmRuntime() {
      runTest {}
      PrototypeRequest()
    }
  }

  private val history = mutableListOf<String>()
  private lateinit var main: FakePrototypeMainThread
  private lateinit var defaultManager: RecordingPrototypeWindowManager
  private lateinit var displays: FakePrototypeDisplays
  private lateinit var host: PrototypeHost
  private var lost = 0

  @Before
  fun setUp() {
    history.clear()
    lost = 0
    main = FakePrototypeMainThread()
    defaultManager = RecordingPrototypeWindowManager(main, history)
    displays = FakePrototypeDisplays(main, history, RuntimeEnvironment.getApplication())
    host =
      DefaultPrototypeHost(
        RuntimeEnvironment.getApplication(),
        defaultManager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = FakePrototypeSettleTimer(history),
        densityProvider = { 2.5f },
        onWindowLost = { lost++ },
        displayWindows = displays,
      )
    ComposeView(RuntimeEnvironment.getApplication())
  }

  private fun sheet(displayId: Int) =
    PrototypeRequest(
      PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 20f),
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
  fun `unknown display leaves the prototype already shown untouched`() = runTest {
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
    assertEquals(
      PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 20f),
      host.currentPlacement,
    )
    // The retained window is the new one: dismiss removes it from display 2.
    assertTrue(host.dismiss())
    assertEquals(1, inner.removals)
    assertEquals(1, defaultManager.removals)
  }

  @Test
  fun `a failed add on the new display keeps the old prototype`() = runTest {
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
  fun `app layer windows use their own application overlay context on the default display`() =
    runTest {
      // The service's WindowManager carries the accessibility-overlay token, which would stack an
      // app-layer window above the notification shade and status bar (#10529).
      val appManager = displays.connect(0)
      assertTrue(host.show(sheet(0).copy(layer = PrototypeWindowLayer.APP)))
      assertEquals(listOf(PrototypeWindowLayer.APP), displays.openedLayers)
      assertEquals(
        WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        appManager.added.single().type,
      )
      assertTrue(defaultManager.added.isEmpty())
      assertTrue(host.show(sheet(0)))
      // A window's type cannot change after add: the system layer attaches a fresh window through
      // the service's own WindowManager and removes the app-layer one.
      assertEquals(
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        defaultManager.added.single().type,
      )
      assertEquals(listOf(PrototypeWindowLayer.APP), displays.openedLayers)
      assertEquals(1, appManager.removals)
      assertTrue(defaultManager.updated.isEmpty())
    }

  @Test
  fun `an app layer window that cannot be opened attaches nothing`() = runTest {
    val error = runCatching { host.show(sheet(0).copy(layer = PrototypeWindowLayer.APP)) }
    assertEquals("Cannot attach an app-layer window", error.exceptionOrNull()?.message)
    assertTrue(defaultManager.added.isEmpty())
    assertFalse(host.isShowing)
  }

  @Test
  fun `secondary display contexts are created for the requested layer`() = runTest {
    val inner = displays.connect(2)
    assertTrue(host.show(sheet(2).copy(layer = PrototypeWindowLayer.APP)))
    assertTrue(host.replace(sheet(2).copy(layer = PrototypeWindowLayer.APP)))
    assertTrue(host.replace(sheet(2)))
    assertEquals(
      listOf(PrototypeWindowLayer.APP, PrototypeWindowLayer.SYSTEM),
      displays.openedLayers,
    )
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
      PrototypeRequest(displayId = -1)
    }
  }
}
