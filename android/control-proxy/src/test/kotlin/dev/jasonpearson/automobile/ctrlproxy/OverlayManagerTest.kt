package dev.jasonpearson.automobile.ctrlproxy

import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import io.mockk.CapturingSlot
import io.mockk.Runs
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.slot
import io.mockk.verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
// Pin the runtime for cutout fields independently of the injected sdkInt used to test API branches.
@Config(sdk = [30])
class OverlayManagerTest {

  private lateinit var windowManager: WindowManager
  private lateinit var viewSlot: CapturingSlot<View>
  private lateinit var paramsSlot: CapturingSlot<ViewGroup.LayoutParams>

  @Before
  fun setUp() {
    windowManager = mockk(relaxed = true)
    viewSlot = slot()
    paramsSlot = slot()
    every { windowManager.addView(capture(viewSlot), capture(paramsSlot)) } just Runs
    every { windowManager.removeViewImmediate(any()) } just Runs
  }

  private fun createOverlayManager(
    canDrawOverlays: Boolean,
    sdkInt: Int = Build.VERSION.SDK_INT,
  ): OverlayManager {
    return OverlayManager(
      RuntimeEnvironment.getApplication(),
      windowManager = windowManager,
      canDrawOverlays = { canDrawOverlays },
      sdkInt = sdkInt,
    )
  }

  @Test
  fun `interactive attach restacks same highlight view above it and dismissal restores normal type`() {
    val manager = createOverlayManager(canDrawOverlays = true)
    manager.show()
    val original = manager.getOverlayViewForTest()
    manager.hide()
    assertTrue(manager.setInteractiveOverlayAttached(true))
    assertTrue(original === manager.getOverlayViewForTest())
    assertFalse(manager.isOverlayVisibleForTest())
    var params = paramsSlot.captured as WindowManager.LayoutParams
    assertEquals(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, params.type)
    assertTrue(params.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE != 0)
    assertTrue(params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE != 0)
    assertTrue(manager.setInteractiveOverlayAttached(false))
    params = paramsSlot.captured as WindowManager.LayoutParams
    assertEquals(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, params.type)
    verify(exactly = 2) { windowManager.removeViewImmediate(any()) }
    verify(exactly = 3) { windowManager.addView(any(), any()) }
  }

  @Test
  fun `restack before first highlight sets accessibility type without creating a view`() {
    val manager = createOverlayManager(canDrawOverlays = true)
    assertTrue(manager.setInteractiveOverlayAttached(true))
    assertNull(manager.getOverlayViewForTest())
    manager.show()
    assertEquals(
      WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
      (paramsSlot.captured as WindowManager.LayoutParams).type,
    )
  }

  @Test
  fun `resolveCutoutMode returns null before API 28`() {
    assertNull(OverlayManager.resolveCutoutMode(21))
    assertNull(OverlayManager.resolveCutoutMode(27))
  }

  @Test
  fun `resolveCutoutMode uses short edges on API 28 and 29`() {
    assertEquals(
      WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES,
      OverlayManager.resolveCutoutMode(28),
    )
    assertEquals(
      WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES,
      OverlayManager.resolveCutoutMode(29),
    )
  }

  @Test
  fun `resolveCutoutMode always allows cutouts from API 30`() {
    for (sdkInt in listOf(30, 34, 36)) {
      assertEquals(
        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS,
        OverlayManager.resolveCutoutMode(sdkInt),
      )
    }
  }

  @Test
  fun `show leaves cutout mode unchanged on API 27`() {
    val overlayManager = createOverlayManager(canDrawOverlays = false, sdkInt = 27)
    assertTrue(overlayManager.show())

    val layoutParams = paramsSlot.captured as WindowManager.LayoutParams
    assertEquals(
      WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT,
      layoutParams.layoutInDisplayCutoutMode,
    )
  }

  @Test
  fun `show uses short edge cutouts on API 28`() {
    val overlayManager = createOverlayManager(canDrawOverlays = true, sdkInt = 28)
    assertTrue(overlayManager.show())

    val layoutParams = paramsSlot.captured as WindowManager.LayoutParams
    assertEquals(
      WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES,
      layoutParams.layoutInDisplayCutoutMode,
    )
  }

  @Test
  fun `show uses short edge cutouts on API 29`() {
    val overlayManager = createOverlayManager(canDrawOverlays = false, sdkInt = 29)
    assertTrue(overlayManager.show())

    val layoutParams = paramsSlot.captured as WindowManager.LayoutParams
    assertEquals(
      WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES,
      layoutParams.layoutInDisplayCutoutMode,
    )
  }

  @Test
  fun `show always allows cutouts on API 30`() {
    val overlayManager = createOverlayManager(canDrawOverlays = true, sdkInt = 30)
    assertTrue(overlayManager.show())

    val layoutParams = paramsSlot.captured as WindowManager.LayoutParams
    assertEquals(
      WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS,
      layoutParams.layoutInDisplayCutoutMode,
    )
  }

  @Test
  fun `show always allows cutouts on API 36`() {
    val overlayManager = createOverlayManager(canDrawOverlays = false, sdkInt = 36)
    assertTrue(overlayManager.show())

    val layoutParams = paramsSlot.captured as WindowManager.LayoutParams
    assertEquals(
      WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS,
      layoutParams.layoutInDisplayCutoutMode,
    )
  }

  @Test
  fun `show uses application overlay when permission granted`() {
    val overlayManager = createOverlayManager(canDrawOverlays = true)
    overlayManager.show()

    verify(exactly = 1) { windowManager.addView(any(), any()) }
    assertTrue(overlayManager.isOverlayAddedForTest())
    assertTrue(overlayManager.isOverlayVisibleForTest())

    val layoutParams = paramsSlot.captured as WindowManager.LayoutParams
    assertEquals(WindowManager.LayoutParams.MATCH_PARENT, layoutParams.width)
    assertEquals(WindowManager.LayoutParams.MATCH_PARENT, layoutParams.height)
    assertEquals(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, layoutParams.type)
    assertTrue(layoutParams.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE != 0)
    assertTrue(layoutParams.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE != 0)
    assertTrue(layoutParams.flags and WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN != 0)
    assertTrue(layoutParams.flags and WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS != 0)
  }

  @Test
  fun `show falls back to accessibility overlay when permission denied`() {
    val overlayManager = createOverlayManager(canDrawOverlays = false)
    overlayManager.show()

    val layoutParams = paramsSlot.captured as WindowManager.LayoutParams
    assertEquals(WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, layoutParams.type)
  }

  @Test
  fun `show is idempotent and hide keeps overlay attached`() {
    val overlayManager = createOverlayManager(canDrawOverlays = true)
    overlayManager.show()
    val overlayView = viewSlot.captured

    overlayManager.show()
    verify(exactly = 1) { windowManager.addView(any(), any()) }
    assertEquals(View.VISIBLE, overlayView.visibility)

    overlayManager.hide()
    verify(exactly = 0) { windowManager.removeViewImmediate(any()) }
    assertEquals(View.GONE, overlayView.visibility)
    assertTrue(overlayManager.isOverlayAddedForTest())
    assertFalse(overlayManager.isOverlayVisibleForTest())
  }

  @Test
  fun `destroy removes overlay and clears state`() {
    val overlayManager = createOverlayManager(canDrawOverlays = true)
    overlayManager.show()
    val overlayView = viewSlot.captured

    overlayManager.destroy()

    verify(exactly = 1) { windowManager.removeViewImmediate(overlayView) }
    assertFalse(overlayManager.isOverlayAddedForTest())
    assertFalse(overlayManager.isOverlayVisibleForTest())
    assertNull(overlayManager.getOverlayViewForTest())
  }
}
