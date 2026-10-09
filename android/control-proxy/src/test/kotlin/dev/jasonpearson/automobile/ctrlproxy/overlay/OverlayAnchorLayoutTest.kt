package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Anchored overlay nodes land on their screen-space dp bounds whatever window they are in (#9316).
 *
 * The target is the Playground `button_elevated` from the captured API 36 overlay hierarchy
 * (`test/fixtures/android-overlay-window/floating-overlay-over-button-elevated.raw.json`):
 * [550,1589,996,1715] px at 420 dpi on a 1080x2400 screen with a 136 px top cutout. The host sends
 * it as px * 160 / 420 dp.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w411dp-h914dp-420dpi")
class OverlayAnchorLayoutTest {
  private val target = Rect(550f, 1589f, 996f, 1715f)
  private val targetDp =
    OverlayBounds(550 / DENSITY_D, 1589 / DENSITY_D, 446 / DENSITY_D, 126 / DENSITY_D)

  private fun cover(offset: OverlayOffset? = null) = OverlayBoundsAnchor(targetDp, "cover", offset)

  private fun box(anchor: OverlayAnchor?, style: OverlayStyle? = null) =
    OverlayBoxNode(testTag = "anchored", anchor = anchor, style = style, children = emptyList())

  /** A column the anchored node sits in, below other content, so its slot is not the origin. */
  private fun nested(node: OverlayNode) =
    OverlayColumnNode(
      style = OverlayStyle(padding = OverlayPadding(start = 12.0, top = 30.0)),
      children = listOf(OverlayTextNode(text = "above"), node, OverlayTextNode(text = "below")),
    )

  private class Rendered(val root: SemanticsNode, val moves: List<IntOffset>)

  /**
   * Renders [root] in the real host chrome for [placement]. [cutoutPx] stands in for the top inset
   * the device applies (Robolectric reports none) and [windowOrigin] for the window's place on
   * screen; [floating] supplies the host's window mover, as the host does for floating windows.
   */
  private fun render(
    placement: OverlayPlacement,
    root: OverlayNode,
    windowOrigin: Offset = Offset.Zero,
    cutoutPx: Int = 0,
    floating: Boolean = false,
  ): Rendered {
    val moves = mutableListOf<IntOffset>()
    val geometry =
      OverlayWindowGeometry({ windowOrigin }, if (floating) { origin -> moves += origin } else null)
    val spec = OverlaySpec("anchor", OverlayWindow(OverlayFullscreenPlacement()), root = root)
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent {
      val cutout = with(LocalDensity.current) { cutoutPx.toDp() }
      CompositionLocalProvider(LocalOverlayWindowGeometry provides geometry) {
        Box(Modifier.padding(top = cutout)) {
          InteractiveOverlayWindowContent(
            InteractiveOverlayRequest(
              placement = placement,
              content = { OverlaySpecContent(mapOverlaySpec(spec).root) },
            ),
          ) {
            OverlayInsetFloor.None
          }
        }
      }
    }
    shadowOf(Looper.getMainLooper()).idle()
    val view = checkNotNull(composeView(activity.window.decorView))
    return Rendered((view as RootForTest).semanticsOwner.unmergedRootSemanticsNode, moves)
  }

  private fun composeView(view: View): View? =
    if (view is RootForTest) view
    else if (view is ViewGroup)
      (0 until view.childCount).firstNotNullOfOrNull { composeView(view.getChildAt(it)) }
    else null

  private fun SemanticsNode.anchored(): SemanticsNode {
    fun find(node: SemanticsNode): SemanticsNode? =
      if (
        node.config.contains(SemanticsProperties.TestTag) &&
          node.config[SemanticsProperties.TestTag] == "anchored"
      )
        node
      else node.children.firstNotNullOfOrNull(::find)
    return checkNotNull(find(this)) { "no anchored node" }
  }

  /**
   * Where the node is drawn in its window, unclipped: `boundsInWindow` clips to every ancestor's
   * bounds, but Compose only clips where a clip modifier or the window does.
   */
  private fun SemanticsNode.drawnInWindow(): Rect =
    Rect(
      positionInWindow,
      androidx.compose.ui.geometry.Size(size.width.toFloat(), size.height.toFloat()),
    )

  private fun assertRect(expected: Rect, actual: Rect) {
    val tolerance = 1f
    val message = "expected $expected but was $actual"
    assertEquals(message, expected.left, actual.left, tolerance)
    assertEquals(message, expected.top, actual.top, tolerance)
    assertEquals(message, expected.right, actual.right, tolerance)
    assertEquals(message, expected.bottom, actual.bottom, tolerance)
  }

  @Test
  fun `the renderer runs at the captured device density`() {
    assertEquals(DENSITY, RuntimeEnvironment.getApplication().resources.displayMetrics.density)
  }

  @Test
  fun `a cover anchor in a fullscreen window lands on the target under the cutout and host row`() {
    val rendered = render(OverlayPlacement.Fullscreen(), nested(box(cover())), cutoutPx = CUTOUT_PX)
    assertRect(target, rendered.root.anchored().drawnInWindow())
  }

  @Test
  fun `a fullscreen window origin is subtracted from the anchor`() {
    val origin = Offset(0f, 48f)
    val rendered = render(OverlayPlacement.Fullscreen(), box(cover()), windowOrigin = origin)
    assertRect(target.translate(-origin), rendered.root.anchored().drawnInWindow())
  }

  @Test
  fun `a cover anchor in a bottom sheet subtracts the sheet window's own origin`() {
    val origin = Offset(0f, 2400f - 1050f)
    val rendered =
      render(
        OverlayPlacement.Sheet(OverlayPlacement.Edge.BOTTOM, 400f),
        nested(box(cover())),
        windowOrigin = origin,
      )
    assertRect(target.translate(-origin), rendered.root.anchored().drawnInWindow())
  }

  @Test
  fun `a safe-area padded parent does not move the anchored node`() {
    val parent =
      OverlayColumnNode(
        safeAreaPadding = OverlaySafeAreaPadding(listOf("top", "start"), listOf("systemBars")),
        style = OverlayStyle(padding = OverlayPadding(top = 40.0, start = 40.0)),
        children = listOf(box(cover())),
      )
    val rendered = render(OverlayPlacement.Fullscreen(), parent, cutoutPx = CUTOUT_PX)
    assertRect(target, rendered.root.anchored().drawnInWindow())
  }

  @Test
  fun `a floating window follows its anchored root and the root fills the window`() {
    val origin = Offset(DENSITY * 24f, DENSITY * 120f)
    val rendered =
      render(
        OverlayPlacement.Floating(offsetXDp = 24f, offsetYDp = 120f),
        box(cover()),
        windowOrigin = origin,
        floating = true,
      )
    assertEquals(IntOffset(550, 1589), rendered.moves.last())
    assertRect(Rect(0f, 0f, 446f, 126f), rendered.root.anchored().drawnInWindow())
  }

  /**
   * The host refuses this spec (only a floating root may be anchored); the layout is still exact.
   */
  @Test
  fun `a nested anchor in a floating window is laid out relative to the window origin`() {
    val origin = Offset(500f, 1500f)
    val rendered =
      render(
        OverlayPlacement.Floating(),
        nested(box(cover())),
        windowOrigin = origin,
        floating = true,
      )
    assertTrue(rendered.moves.isEmpty())
    assertRect(target.translate(-origin), rendered.root.anchored().drawnInWindow())
  }

  @Test
  fun `a bottom anchor keeps the node's size, aligns its bottom edge and applies the offset`() {
    val size = OverlayStyle(width = OverlayDimension.Dp(100.0), height = OverlayDimension.Dp(20.0))
    val anchor = OverlayBoundsAnchor(targetDp, "bottom", OverlayOffset(0.0, 8.0))
    val rendered =
      render(OverlayPlacement.Fullscreen(), nested(box(anchor, size)), cutoutPx = CUTOUT_PX)
    val width = 100 * DENSITY
    val height = 20 * DENSITY
    val left = target.center.x - width / 2
    val bottom = target.bottom + 8 * DENSITY
    assertRect(
      Rect(left, bottom - height, left + width, bottom),
      rendered.root.anchored().drawnInWindow(),
    )
  }

  @Test
  fun `anchor rectangles at several densities`() {
    for (density in listOf(2.625f, 2.75f, 2.33125f, 1f)) {
      val bounds =
        OverlayBounds(
          550 / density.toDouble(),
          1589 / density.toDouble(),
          446 / density.toDouble(),
          126 / density.toDouble(),
        )
      val rect =
        overlayAnchorRect(OverlayBoundsAnchor(bounds), density, 0f, 0f, LayoutDirection.Ltr)
      assertRect(target, rect)
    }
  }

  @Test
  fun `edge alignments centre on the other axis and start and end follow layout direction`() {
    val anchor = { alignment: String ->
      OverlayBoundsAnchor(OverlayBounds(10.0, 20.0, 100.0, 40.0), alignment)
    }
    fun rect(alignment: String, direction: LayoutDirection = LayoutDirection.Ltr) =
      overlayAnchorRect(anchor(alignment), 2f, 40f, 20f, direction)
    assertEquals(Rect(100f, 40f, 140f, 60f), rect("top"))
    assertEquals(Rect(100f, 100f, 140f, 120f), rect("bottom"))
    assertEquals(Rect(20f, 70f, 60f, 90f), rect("start"))
    assertEquals(Rect(180f, 70f, 220f, 90f), rect("end"))
    assertEquals(Rect(180f, 70f, 220f, 90f), rect("start", LayoutDirection.Rtl))
    assertEquals(Rect(20f, 70f, 60f, 90f), rect("end", LayoutDirection.Rtl))
    assertEquals(
      Rect(26f, 34f, 226f, 114f),
      overlayAnchorRect(
        OverlayBoundsAnchor(
          OverlayBounds(10.0, 20.0, 100.0, 40.0),
          offset = OverlayOffset(3.0, -3.0),
        ),
        2f,
        0f,
        0f,
        LayoutDirection.Ltr,
      ),
    )
  }

  @Test
  fun `an element anchor that reaches the device unresolved is refused with its path`() {
    val element = OverlayElementAnchor(OverlaySelector(testTag = "buy"), alignment = "cover")
    val error =
      assertThrows(IllegalArgumentException::class.java) {
        requireResolvedOverlayAnchors(nested(box(element)))
      }
    assertEquals(
      "root.children[1].anchor: Element anchors must be resolved to bounds by the host; update the AutoMobile host",
      error.message,
    )
    requireResolvedOverlayAnchors(nested(box(cover())))
  }

  private companion object {
    const val DENSITY = 2.625f
    const val DENSITY_D = 2.625
    const val CUTOUT_PX = 136
  }
}
