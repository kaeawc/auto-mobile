package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.graphics.PixelFormat
import android.view.Gravity
import android.view.WindowManager.LayoutParams
import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30])
class PrototypePlacementTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmRuntime() {
      // Warm the params builder before method bodies; application bootstrap remains runner-owned.
      prototypeLayoutParams(PrototypePlacement.Fullscreen(Color.Black), false, 2.5f, 30)
    }
  }

  @Test
  fun `fullscreen blocks entire display with optional scrim`() {
    val params = build(PrototypePlacement.Fullscreen(Color.Black.copy(alpha = 0.4f)))
    assertEquals(LayoutParams.MATCH_PARENT, params.width)
    assertEquals(LayoutParams.MATCH_PARENT, params.height)
    assertEquals(Gravity.TOP or Gravity.START, params.gravity)
    assertEquals(0, params.x)
    assertEquals(0, params.y)
    assertEquals(PixelFormat.TRANSLUCENT, params.format)
    assertEquals(
      LayoutParams.FLAG_NOT_TOUCH_MODAL or
        LayoutParams.FLAG_LAYOUT_IN_SCREEN or
        LayoutParams.FLAG_NOT_FOCUSABLE,
      params.flags,
    )
    assertEquals(0, params.fitInsetsTypes)
  }

  @Test
  fun `sheets anchor all edges and convert size with display density`() {
    val expectedGravity = listOf(Gravity.TOP, Gravity.BOTTOM, Gravity.START, Gravity.END)
    PrototypePlacement.Edge.entries.forEachIndexed { index, edge ->
      val params = build(PrototypePlacement.Sheet(edge, 10f))
      val horizontal = edge == PrototypePlacement.Edge.TOP || edge == PrototypePlacement.Edge.BOTTOM
      assertEquals(if (horizontal) LayoutParams.MATCH_PARENT else 25, params.width)
      assertEquals(if (horizontal) 25 else LayoutParams.MATCH_PARENT, params.height)
      assertEquals(expectedGravity[index], params.gravity)
      assertEquals(LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, params.type)
    }
  }

  @Test
  fun `floating wraps content and converts signed offsets and gravity`() {
    val params = build(PrototypePlacement.Floating(Gravity.BOTTOM or Gravity.END, 3f, -4f))
    assertEquals(LayoutParams.WRAP_CONTENT, params.width)
    assertEquals(LayoutParams.WRAP_CONTENT, params.height)
    assertEquals(Gravity.BOTTOM or Gravity.END, params.gravity)
    assertEquals(8, params.x)
    assertEquals(-10, params.y)
  }

  @Test
  fun `text fields alone make every placement focusable without disabling touches`() {
    placements().forEach { placement ->
      val params = build(placement, hasTextField = true)
      assertEquals(
        LayoutParams.FLAG_NOT_TOUCH_MODAL or LayoutParams.FLAG_LAYOUT_IN_SCREEN,
        params.flags,
      )
      assertFalse(params.flags and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
      assertFalse(params.flags and LayoutParams.FLAG_NOT_TOUCHABLE != 0)
      assertTrue(build(placement).flags and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
    }
  }

  @Test
  fun `a non-focusable app-layer window stays below the keyboard until a text field needs focus`() {
    placements().forEach { placement ->
      val idle = prototypeLayoutParams(placement, false, 2.5f, 30, PrototypeWindowLayer.APP).flags
      assertTrue(idle and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
      assertTrue(idle and LayoutParams.FLAG_ALT_FOCUSABLE_IM != 0)
      val typing = prototypeLayoutParams(placement, true, 2.5f, 30, PrototypeWindowLayer.APP).flags
      assertFalse(typing and LayoutParams.FLAG_NOT_FOCUSABLE != 0)
      assertFalse(typing and LayoutParams.FLAG_ALT_FOCUSABLE_IM != 0)
      // The system layer is untouched.
      assertFalse(build(placement).flags and LayoutParams.FLAG_ALT_FOCUSABLE_IM != 0)
    }
  }

  @Test
  fun `accessibility type is pinned across placements and cutout API branches`() {
    val expected = mapOf(27 to 0, 28 to 1, 29 to 1, 30 to 3, 36 to 3)
    expected.forEach { (sdk, cutout) ->
      placements().forEach { placement ->
        val params = prototypeLayoutParams(placement, false, 2.5f, sdk)
        assertEquals(LayoutParams.TYPE_ACCESSIBILITY_OVERLAY, params.type)
        assertFalse(params.type == LayoutParams.TYPE_APPLICATION_OVERLAY)
        assertEquals(cutout, params.layoutInDisplayCutoutMode)
      }
    }
  }

  @Test(expected = IllegalArgumentException::class)
  fun `density must be positive`() {
    prototypeLayoutParams(PrototypePlacement.Fullscreen(), false, 0f, 30)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `sheet must have a positive size`() {
    PrototypePlacement.Sheet(PrototypePlacement.Edge.TOP, 0f)
  }

  @Test(expected = IllegalArgumentException::class)
  fun `floating offsets must be finite`() {
    PrototypePlacement.Floating(offsetXDp = Float.NaN)
  }

  private fun build(placement: PrototypePlacement, hasTextField: Boolean = false) =
    prototypeLayoutParams(placement, hasTextField, 2.5f, 30)

  private fun placements(): List<PrototypePlacement> =
    listOf(PrototypePlacement.Fullscreen(), PrototypePlacement.Floating()) +
      PrototypePlacement.Edge.entries.map { PrototypePlacement.Sheet(it, 20f) }
}
