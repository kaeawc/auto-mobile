package dev.jasonpearson.automobile.ctrlproxy

import android.animation.ValueAnimator
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.RectF
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightBounds
import dev.jasonpearson.automobile.ctrlproxy.models.HighlightShape
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Guards the highlight-overlay per-frame cost reductions from issue #5465:
 * - at most one `invalidate()` per animation frame (alpha + draw-progress updates coalesce),
 * - no per-frame render-list allocation (the snapshot is rebuilt only when the set changes),
 * - a bounded ellipse segment count.
 */
@RunWith(RobolectricTestRunner::class)
class OverlayDrawerTest {

  private fun boxShape(): HighlightShape =
    HighlightShape(type = "box", bounds = HighlightBounds(x = 0, y = 0, width = 120, height = 80))

  private fun createDrawer(view: HighlightOverlayView): OverlayDrawer {
    val overlayManager = mockk<OverlayManager>(relaxed = true)
    every { overlayManager.show() } returns true
    val drawer =
      OverlayDrawer(
        overlayManager = overlayManager,
        colorParser = { Color.RED },
      )
    drawer.attachView(view)
    return drawer
  }

  @Test
  fun `each animation frame schedules at most one invalidate`() {
    val view = mockk<HighlightOverlayView>(relaxed = true)
    val drawer = createDrawer(view)
    val canvas = mockk<Canvas>(relaxed = true)

    // addHighlight schedules the initial redraw.
    assertTrue(drawer.addHighlight("h", boxShape()).success)
    val animator: ValueAnimator = drawer.getAnimatorForTest("h")!!

    // Frame 1: consume the pending invalidate, then advance the animator. The
    // animator drives alpha AND draw-progress in the same frame; both funnel into
    // a single scheduled invalidate.
    drawer.draw(canvas)
    animator.setCurrentPlayTime(100)

    // Frame 2.
    drawer.draw(canvas)
    animator.setCurrentPlayTime(200)

    // 1 (addHighlight) + 1 (frame 1) + 1 (frame 2) = 3. Without coalescing the two
    // per-frame updates it would be 5.
    verify(exactly = 3) { view.invalidate() }
  }

  @Test
  fun `onDraw does not rebuild the render snapshot every frame`() {
    val view = mockk<HighlightOverlayView>(relaxed = true)
    val drawer = createDrawer(view)
    val canvas = mockk<Canvas>(relaxed = true)

    assertTrue(drawer.addHighlight("h", boxShape()).success)
    val afterAdd = drawer.snapshotRebuildCountForTest()

    repeat(10) { drawer.draw(canvas) }

    // Drawing must not rebuild the snapshot list; the count is stable across frames.
    assertEquals(afterAdd, drawer.snapshotRebuildCountForTest())

    // A change to the highlight set does rebuild it exactly once.
    assertTrue(drawer.addHighlight("h2", boxShape()).success)
    assertEquals(afterAdd + 1, drawer.snapshotRebuildCountForTest())
  }

  @Test
  fun `full ellipse draw uses a bounded number of arc segments`() {
    val view = mockk<HighlightOverlayView>(relaxed = true)
    val drawer = createDrawer(view)
    val canvas = mockk<Canvas>(relaxed = true)

    assertTrue(drawer.addHighlight("h", boxShape()).success)
    val animator: ValueAnimator = drawer.getAnimatorForTest("h")!!

    // Advance into the display phase where drawProgress == 1 (all segments drawn).
    animator.setCurrentPlayTime(700)
    drawer.draw(canvas)

    verify(atMost = 64) { canvas.drawArc(any<RectF>(), any(), any(), any(), any()) }
    verify(atLeast = 1) { canvas.drawArc(any<RectF>(), any(), any(), any(), any()) }
  }
}
