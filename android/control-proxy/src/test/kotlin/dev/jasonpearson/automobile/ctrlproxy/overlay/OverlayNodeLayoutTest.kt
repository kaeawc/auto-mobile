package dev.jasonpearson.automobile.ctrlproxy.overlay

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/** Layout, hit area and accessibility bounds of rendered overlay nodes (#10435, #10436). */
@RunWith(RobolectricTestRunner::class)
class OverlayNodeLayoutTest {
  private val tap = listOf<OverlayAction>(OverlayEmitAction("tapped"))

  private fun render(root: OverlayNode): SemanticsNode {
    val spec = OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), root = root)
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent { OverlaySpecContent(mapOverlaySpec(spec).root) }
    shadowOf(Looper.getMainLooper()).idle()
    val view = checkNotNull(composeView(activity.window.decorView))
    return (view as RootForTest).semanticsOwner.unmergedRootSemanticsNode
  }

  private fun composeView(view: View): View? =
    if (view is RootForTest) view
    else if (view is ViewGroup)
      (0 until view.childCount).firstNotNullOfOrNull {
        composeView(view.getChildAt(it))
      }
    else null

  private fun SemanticsNode.find(predicate: (SemanticsNode) -> Boolean): SemanticsNode? =
    if (predicate(this)) this else children.firstNotNullOfOrNull { it.find(predicate) }

  private fun SemanticsNode.tagged(tag: String): SemanticsNode =
    checkNotNull(
      find {
        it.config.contains(SemanticsProperties.TestTag) &&
          it.config[SemanticsProperties.TestTag] == tag
      }
    ) {
      "no node tagged $tag"
    }

  private fun SemanticsNode.labelled(label: String): SemanticsNode =
    checkNotNull(
      find {
        it.config.contains(SemanticsProperties.ContentDescription) &&
          it.config[SemanticsProperties.ContentDescription] == listOf(label)
      }
    ) {
      "no node labelled $label"
    }

  private fun dp(value: Float): Float =
    value * RuntimeEnvironment.getApplication().resources.displayMetrics.density

  @Test
  fun `a padded tappable node reports its padding inside its bounds`() {
    val root =
      render(
        OverlayColumnNode(
          children =
            listOf(
              OverlayBoxNode(
                testTag = "done",
                onTap = tap,
                style =
                  OverlayStyle(
                    padding = OverlayPadding(start = 24.0, end = 24.0, top = 10.0, bottom = 10.0)
                  ),
                children =
                  listOf(OverlayTextNode(text = "Done", style = OverlayStyle(textSize = 30.0))),
              )
            )
        )
      )
    val button = root.tagged("done").boundsInRoot
    val label = root.labelled("Done").boundsInRoot
    assertEquals(
      Rect(
        label.left - dp(24f),
        label.top - dp(10f),
        label.right + dp(24f),
        label.bottom + dp(10f),
      ),
      button,
    )
    val click = checkNotNull(root.tagged("done").config[SemanticsActions.OnClick].action)
    assertEquals(true, click())
  }

  @Test
  fun `a small tappable node keeps its drawn size inside a 48 dp touch target`() {
    val small = OverlayStyle(width = OverlayDimension.Dp(20.0), height = OverlayDimension.Dp(20.0))
    val root =
      render(
        OverlayColumnNode(
          children =
            listOf(
              OverlayBoxNode(testTag = "small", onTap = tap, style = small, children = emptyList()),
              OverlayBoxNode(testTag = "plain", style = small, children = emptyList()),
              OverlayBoxNode(testTag = "after", style = small, children = emptyList()),
            )
        )
      )
    val tappable = root.tagged("small").boundsInRoot
    assertEquals(dp(20f), tappable.width, 0.5f)
    assertEquals(dp(20f), tappable.height, 0.5f)
    // The reserved 48 dp is centred on the drawn node and pushes the next sibling down.
    assertEquals(dp(14f), tappable.top - root.tagged("small").parent!!.boundsInRoot.top, 0.5f)
    val plain = root.tagged("plain").boundsInRoot
    assertEquals(tappable.top + dp(34f), plain.top, 0.5f)
    // A node without onTap gets no reserved space.
    assertEquals(plain.bottom, root.tagged("after").boundsInRoot.top, 0.5f)
  }

  @Test
  fun `text size is in sp and follows the system font scale`() {
    RuntimeEnvironment.setFontScale(2f)
    val root = render(OverlayTextNode(text = "Scaled", style = OverlayStyle(textSize = 20.0)))
    val layouts = mutableListOf<TextLayoutResult>()
    checkNotNull(root.labelled("Scaled").config[SemanticsActions.GetTextLayoutResult].action)(
      layouts
    )
    val input = layouts.single().layoutInput
    assertEquals(20.sp, input.style.fontSize)
    assertEquals(2f, input.density.fontScale)
  }
}
