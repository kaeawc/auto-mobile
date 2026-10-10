package dev.jasonpearson.automobile.ctrlproxy.prototype

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
class PrototypeAnchorLayerTest {
  private class Rendered(
    val view: View,
    val root: SemanticsNode,
    val moves: List<IntOffset>,
    val interactions: List<PrototypeInteraction>,
  )

  private fun render(
    root: PrototypeNode,
    placement: PrototypePlacement = PrototypePlacement.Fullscreen(),
    windowOrigin: Offset = Offset.Zero,
    floating: Boolean = false,
  ): Rendered {
    val moves = mutableListOf<IntOffset>()
    val interactions = mutableListOf<PrototypeInteraction>()
    val geometry =
      PrototypeWindowGeometry(
        { windowOrigin },
        if (floating) { origin -> moves += origin } else null,
      )
    val spec = PrototypeSpec("anchor", PrototypeWindow(PrototypeFullscreenPlacement()), root = root)
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent {
      CompositionLocalProvider(
        LocalPrototypeWindowGeometry provides geometry,
        LocalPrototypeMotion provides true,
      ) {
        PrototypeWindowContent(
          PrototypeRequest(
            placement = placement,
            content = { PrototypeSpecContent(mapPrototypeSpec(spec).root) { interactions += it } },
          ),
        ) {
          PrototypeInsetFloor.None
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
    onTap: List<PrototypeAction>? = null,
  ) =
    PrototypeBoxNode(
      testTag = tag,
      anchor = PrototypeBoundsAnchor(PrototypeBounds(x, y, size, size), "cover"),
      onTap = onTap,
      style = PrototypeStyle(background = "#FF0000"),
      children = emptyList(),
    )

  private val small = anchored("small", 100.0, 300.0, 100.0, listOf(PrototypeEmitAction("small")))
  private val large = anchored("large", 100.0, 100.0, 300.0)

  private fun dpRect(x: Float, y: Float, size: Float) =
    Rect(x * DENSITY, y * DENSITY, (x + size) * DENSITY, (y + size) * DENSITY)

  private fun wrapRoot(vararg children: PrototypeNode) =
    PrototypeBoxNode(testTag = "root", children = children.toList())

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
  fun `a wrap-content window keeps its measured size when every child of the root is anchored`() {
    // Filling a zero-size root would grow a floating or sheet window to the screen, where it would
    // block touches on the app below (#10870). Only a fullscreen window is already that size.
    val placements =
      listOf(
        PrototypePlacement.Floating(offsetXDp = 24f, offsetYDp = 120f),
        PrototypePlacement.Sheet(PrototypePlacement.Edge.BOTTOM, 200f),
      )
    for (placement in placements) {
      val rendered = render(wrapRoot(small, large), placement)
      val content = checkNotNull(rendered.root.tagged("root").layoutInfo.parentInfo)
      assertEquals("$placement width", 0, content.width)
      assertEquals("$placement height", 0, content.height)
    }
    val fullscreen =
      checkNotNull(render(wrapRoot(small, large)).root.tagged("root").layoutInfo.parentInfo)
    assertEquals(true, fullscreen.width > 0 && fullscreen.height > 0)
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
      PrototypeColumnNode(
        testTag = "column",
        children = listOf(large, PrototypeTextNode(testTag = "below", text = "below")),
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
      PrototypeBoxNode(
        testTag = "root",
        style = PrototypeStyle(width = PrototypeDimension.Fill, height = PrototypeDimension.Fill),
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
      listOf(PrototypeInteraction.Tap(listOf(PrototypeEmitAction("small")))),
      rendered.interactions,
    )
  }

  @Test
  fun `a floating window still moves onto its anchored root`() {
    val origin = Offset(DENSITY * 24f, DENSITY * 120f)
    val root =
      PrototypeBoxNode(
        testTag = "root",
        anchor = PrototypeBoundsAnchor(PrototypeBounds(100.0, 300.0, 100.0, 100.0), "cover"),
        children = emptyList(),
      )
    val rendered =
      render(
        root,
        PrototypePlacement.Floating(offsetXDp = 24f, offsetYDp = 120f),
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
