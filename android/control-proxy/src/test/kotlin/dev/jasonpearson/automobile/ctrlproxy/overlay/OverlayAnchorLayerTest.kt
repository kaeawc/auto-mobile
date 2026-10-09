package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.IntOffset
import dev.jasonpearson.automobile.protocol.*
import kotlin.math.roundToInt
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Anchored nodes below the root are drawn in a window-level layer (#10803): a wrap-content parent
 * neither clips them to its slot nor reserves one for them. The specs are the #9316 device check's
 * (pixel_7, API 36): a 100 dp box anchored at (100, 300) and a 300 dp box anchored at (100, 100)
 * under a wrap-content root box. Motion is on, as on a device, so containers animate their size
 * (which clips).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-420dpi")
class OverlayAnchorLayerTest {
  private class Rendered(
    val view: View,
    val root: SemanticsNode,
    val moves: List<IntOffset>,
    val interactions: List<OverlayInteraction>,
  )

  private fun render(
    root: OverlayNode,
    placement: OverlayPlacement = OverlayPlacement.Fullscreen(),
    windowOrigin: Offset = Offset.Zero,
    floating: Boolean = false,
  ): Rendered {
    val moves = mutableListOf<IntOffset>()
    val interactions = mutableListOf<OverlayInteraction>()
    val geometry =
      OverlayWindowGeometry({ windowOrigin }, if (floating) { origin -> moves += origin } else null)
    val spec = OverlaySpec("anchor", OverlayWindow(OverlayFullscreenPlacement()), root = root)
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent {
      CompositionLocalProvider(
        LocalOverlayWindowGeometry provides geometry,
        LocalOverlayMotion provides true,
      ) {
        InteractiveOverlayWindowContent(
          InteractiveOverlayRequest(
            placement = placement,
            content = { OverlaySpecContent(mapOverlaySpec(spec).root) { interactions += it } },
          ),
        ) {
          OverlayInsetFloor.None
        }
      }
    }
    shadowOf(Looper.getMainLooper()).idle()
    val view = checkNotNull(composeView(activity.window.decorView))
    return Rendered(
      view,
      (view as RootForTest).semanticsOwner.unmergedRootSemanticsNode,
      moves,
      interactions,
    )
  }

  private fun composeView(view: View): View? =
    if (view is RootForTest) view
    else if (view is ViewGroup)
      (0 until view.childCount).firstNotNullOfOrNull { composeView(view.getChildAt(it)) }
    else null

  private fun SemanticsNode.tagged(tag: String): SemanticsNode {
    fun find(node: SemanticsNode): SemanticsNode? =
      if (
        node.config.contains(SemanticsProperties.TestTag) &&
          node.config[SemanticsProperties.TestTag] == tag
      )
        node
      else node.children.firstNotNullOfOrNull(::find)
    return checkNotNull(find(this)) { "no node tagged $tag" }
  }

  private fun SemanticsNode.drawnInWindow(): Rect =
    Rect(positionInWindow, Size(size.width.toFloat(), size.height.toFloat()))

  private fun assertRect(expected: Rect, actual: Rect) {
    val message = "expected $expected but was $actual"
    assertEquals(message, expected.left, actual.left, 1f)
    assertEquals(message, expected.top, actual.top, 1f)
    assertEquals(message, expected.right, actual.right, 1f)
    assertEquals(message, expected.bottom, actual.bottom, 1f)
  }

  private fun anchored(
    tag: String,
    x: Double,
    y: Double,
    size: Double,
    onTap: List<OverlayAction>? = null,
  ) =
    OverlayBoxNode(
      testTag = tag,
      anchor = OverlayBoundsAnchor(OverlayBounds(x, y, size, size), "cover"),
      onTap = onTap,
      style = OverlayStyle(background = "#FF0000"),
      children = emptyList(),
    )

  private val small = anchored("small", 100.0, 300.0, 100.0, listOf(OverlayEmitAction("small")))
  private val large = anchored("large", 100.0, 100.0, 300.0)

  private fun dpRect(x: Float, y: Float, size: Float) =
    Rect(x * DENSITY, y * DENSITY, (x + size) * DENSITY, (y + size) * DENSITY)

  private fun wrapRoot(vararg children: OverlayNode) =
    OverlayBoxNode(testTag = "root", children = children.toList())

  @Test
  fun `a zero-size wrap root still exposes its anchored nodes to accessibility at their anchors`() {
    val rendered = render(wrapRoot(small, large))
    val provider = checkNotNull(rendered.view.accessibilityNodeProvider)
    for ((tag, expected) in
      listOf("small" to dpRect(100f, 300f, 100f), "large" to dpRect(100f, 100f, 300f))) {
      // Compose clips a node's accessibility bounds to its ancestors: an empty ancestor reported
      // empty, invisible bounds and `observe` dropped the node (#10870).
      val info = checkNotNull(provider.createAccessibilityNodeInfo(rendered.root.tagged(tag).id))
      val bounds = android.graphics.Rect()
      info.getBoundsInScreen(bounds)
      assertRect(
        expected,
        Rect(
          bounds.left.toFloat(),
          bounds.top.toFloat(),
          bounds.right.toFloat(),
          bounds.bottom.toFloat(),
        ),
      )
    }
  }

  @Test
  fun `anchors under a wrap-content root are drawn and reported where they are anchored`() {
    val rendered = render(wrapRoot(small, large))
    for ((tag, expected) in
      listOf("small" to dpRect(100f, 300f, 100f), "large" to dpRect(100f, 100f, 300f))) {
      val node = rendered.root.tagged(tag)
      assertRect(expected, node.drawnInWindow())
      // Accessibility bounds clip to every clipping ancestor: they match the drawn rectangle only
      // when nothing between the node and the window cut it.
      assertRect(expected, node.boundsInWindow)
    }
  }

  @Test
  fun `the parent reserves no slot for its anchored children`() {
    val rendered = render(wrapRoot(small, large))
    val root = rendered.root.tagged("root")
    assertEquals(0, root.size.width)
    assertEquals(0, root.size.height)
    val column =
      OverlayColumnNode(
        testTag = "column",
        children = listOf(large, OverlayTextNode(testTag = "below", text = "below")),
      )
    val stacked = render(column)
    // The text is the column's first laid-out child: the anchored node above it took no slot.
    assertEquals(
      stacked.root.tagged("column").positionInWindow.y,
      stacked.root.tagged("below").positionInWindow.y,
      0f,
    )
  }

  @Test
  fun `a fill root places the anchors exactly as before`() {
    val fill =
      OverlayBoxNode(
        testTag = "root",
        style = OverlayStyle(width = OverlayDimension.Fill, height = OverlayDimension.Fill),
        children = listOf(small, large),
      )
    val rendered = render(fill)
    assertRect(dpRect(100f, 300f, 100f), rendered.root.tagged("small").boundsInWindow)
    assertRect(dpRect(100f, 100f, 300f), rendered.root.tagged("large").boundsInWindow)
  }

  @Test
  fun `a tap lands on the anchored node where it is drawn`() {
    val rendered = render(wrapRoot(small, large))
    val target = dpRect(100f, 300f, 100f).center
    val location = IntArray(2)
    rendered.view.getLocationInWindow(location)
    tap(rendered.view, target.x - location[0], target.y - location[1])
    assertEquals(
      listOf(OverlayInteraction.Tap(listOf(OverlayEmitAction("small")))),
      rendered.interactions,
    )
  }

  @Test
  fun `a floating window still moves onto its anchored root`() {
    val origin = Offset(DENSITY * 24f, DENSITY * 120f)
    val root =
      OverlayBoxNode(
        testTag = "root",
        anchor = OverlayBoundsAnchor(OverlayBounds(100.0, 300.0, 100.0, 100.0), "cover"),
        children = emptyList(),
      )
    val rendered =
      render(
        root,
        OverlayPlacement.Floating(offsetXDp = 24f, offsetYDp = 120f),
        windowOrigin = origin,
        floating = true,
      )
    val expected = dpRect(100f, 300f, 100f)
    assertEquals(
      IntOffset(expected.left.roundToInt(), expected.top.roundToInt()),
      rendered.moves.last(),
    )
    assertRect(
      Rect(0f, 0f, expected.width, expected.height),
      rendered.root.tagged("root").drawnInWindow(),
    )
  }

  private fun tap(view: View, x: Float, y: Float) {
    val time = SystemClock.uptimeMillis()
    for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
      val event = MotionEvent.obtain(time, time, action, x, y, 0)
      view.dispatchTouchEvent(event)
      event.recycle()
      shadowOf(Looper.getMainLooper()).idle()
    }
  }

  private companion object {
    const val DENSITY = 2.625f
  }
}
