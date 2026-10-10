package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.view.Gravity
import android.view.WindowManager.LayoutParams
import android.view.accessibility.AccessibilityWindowInfo
import androidx.compose.ui.platform.ComposeView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** #10262: a bottom sheet rides the keyboard; every other placement is untouched. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class OverlayImeLiftTest {
  private val history = mutableListOf<String>()
  private lateinit var manager: RecordingOverlayWindowManager
  private lateinit var host: InteractiveOverlayHost
  private var lift = 0
  private var blocked = false

  @Before
  fun setUp() {
    history.clear()
    lift = 0
    blocked = false
    val main = FakeOverlayMainThread()
    manager = RecordingOverlayWindowManager(main, history)
    host =
      DefaultInteractiveOverlayHost(
        RuntimeEnvironment.getApplication(),
        manager,
        sdkInt = 30,
        mainThread = main,
        settleTimer = FakeOverlaySettleTimer(history),
        densityProvider = { 2f },
        isBlocked = { blocked },
        imeInset = OverlayImeInset { lift },
        backScope = CoroutineScope(Dispatchers.Unconfined),
      )
    ComposeView(RuntimeEnvironment.getApplication())
  }

  private val bottomSheet = OverlayPlacement.Sheet(OverlayPlacement.Edge.BOTTOM, 100f)

  @Test
  fun `bottom sheet sits at the edge with the keyboard hidden`() = runTest {
    host.show(InteractiveOverlayRequest(bottomSheet))
    assertEquals(0, manager.added.last().y)
    assertEquals(Gravity.BOTTOM, manager.added.last().gravity)
  }

  @Test
  fun `showing the keyboard lifts the sheet by its height and hiding returns it`() = runTest {
    host.show(InteractiveOverlayRequest(bottomSheet))
    lift = 840
    assertTrue(host.relayout())
    assertEquals(840, manager.updated.last().y)
    assertEquals(Gravity.BOTTOM, manager.updated.last().gravity)
    assertEquals(200, manager.updated.last().height)
    lift = 0
    assertTrue(host.relayout())
    assertEquals(0, manager.updated.last().y)
  }

  @Test
  fun `a sheet shown while the keyboard is up starts above it and never lets the system pan it`() =
    runTest {
      lift = 600
      host.show(InteractiveOverlayRequest(bottomSheet, hasTextField = true))
      assertEquals(600, manager.added.last().y)
      assertEquals(LayoutParams.SOFT_INPUT_ADJUST_NOTHING, manager.added.last().softInputMode)
    }

  @Test
  fun `lift is kept through touch-through so the touch region stays on the moved window`() =
    runTest {
      host.show(InteractiveOverlayRequest(bottomSheet))
      lift = 500
      host.relayout()
      host.withTouchThrough {
        assertEquals(500, manager.updated.last().y)
        assertTrue(manager.updated.last().flags and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
      }
      assertEquals(500, manager.updated.last().y)
      assertEquals(0, manager.updated.last().flags and LayoutParams.FLAG_NOT_TOUCHABLE)
    }

  @Test
  fun `floating fullscreen top and side placements ignore the keyboard`() = runTest {
    lift = 700
    val placements =
      listOf(
        OverlayPlacement.Floating(Gravity.BOTTOM or Gravity.START, 4f, 8f),
        OverlayPlacement.Fullscreen(),
        OverlayPlacement.Sheet(OverlayPlacement.Edge.TOP, 100f),
        OverlayPlacement.Sheet(OverlayPlacement.Edge.START, 100f),
        OverlayPlacement.Sheet(OverlayPlacement.Edge.END, 100f),
      )
    placements.forEach { placement ->
      host.show(InteractiveOverlayRequest(placement))
      host.relayout()
      val params = manager.updated.last()
      val expectedY = if (placement is OverlayPlacement.Floating) 16 else 0
      assertEquals("$placement", expectedY, params.y)
      assertEquals("$placement", LayoutParams.SOFT_INPUT_ADJUST_UNSPECIFIED, params.softInputMode)
    }
  }

  @Test
  fun `an unreadable keyboard leaves the sheet at the edge`() = runTest {
    val main = FakeOverlayMainThread()
    val throwing =
      DefaultInteractiveOverlayHost(
        RuntimeEnvironment.getApplication(),
        RecordingOverlayWindowManager(main, history).also { manager = it },
        sdkInt = 30,
        mainThread = main,
        densityProvider = { 2f },
        imeInset = OverlayImeInset { error("no windows") },
        backScope = CoroutineScope(Dispatchers.Unconfined),
      )
    throwing.show(InteractiveOverlayRequest(bottomSheet))
    assertEquals(0, manager.added.last().y)
  }

  @Test
  fun `lift is the distance from the screen bottom to the topmost keyboard window`() {
    val ime = AccessibilityWindowInfo.TYPE_INPUT_METHOD
    val app = AccessibilityWindowInfo.TYPE_APPLICATION
    assertEquals(0, imeLiftPx(emptyList(), 2400))
    assertEquals(0, imeLiftPx(listOf(OverlayImeWindow(app, 0, 2400)), 2400))
    assertEquals(0, imeLiftPx(listOf(OverlayImeWindow(ime, 2400, 2400)), 2400))
    assertEquals(
      900,
      imeLiftPx(listOf(OverlayImeWindow(app, 0, 2400), OverlayImeWindow(ime, 1500, 2400)), 2400),
    )
    assertEquals(
      900,
      imeLiftPx(listOf(OverlayImeWindow(ime, 1700, 2400), OverlayImeWindow(ime, 1500, 2400)), 2400),
    )
    assertEquals(0, imeLiftPx(listOf(OverlayImeWindow(ime, 2600, 2900)), 2400))
  }
}
