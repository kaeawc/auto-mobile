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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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

  private fun render(root: OverlayNode, theme: OverlaySpecTheme? = null): SemanticsNode {
    val spec = OverlaySpec("panel", OverlayWindow(OverlayFullscreenPlacement()), root = root)
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent { OverlaySpecContent(mapOverlaySpec(spec).root, theme) }
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

  private fun SemanticsNode.textStyleOf(label: String) =
    mutableListOf<TextLayoutResult>()
      .also {
        checkNotNull(labelled(label).config[SemanticsActions.GetTextLayoutResult].action)(it)
      }
      .single()
      .layoutInput
      .style

  @Test
  fun `weighted children without a width share the row`() {
    val weighted = OverlayStyle(weight = 1.0, height = OverlayDimension.Dp(20.0))
    val root =
      render(
        OverlayRowNode(
          testTag = "row",
          style = OverlayStyle(width = OverlayDimension.Dp(200.0)),
          children =
            listOf(
              OverlayBoxNode(testTag = "a", style = weighted, children = emptyList()),
              OverlayBoxNode(testTag = "b", style = weighted, children = emptyList()),
            ),
        )
      )
    assertEquals(dp(100f), root.tagged("a").boundsInRoot.width, 0.5f)
    assertEquals(dp(100f), root.tagged("b").boundsInRoot.width, 0.5f)
    assertEquals(root.tagged("a").boundsInRoot.right, root.tagged("b").boundsInRoot.left, 0.5f)
  }

  @Test
  fun `weighted children without a height share the column`() {
    val weighted = OverlayStyle(weight = 1.0, width = OverlayDimension.Dp(20.0))
    val root =
      render(
        OverlayColumnNode(
          style = OverlayStyle(height = OverlayDimension.Dp(120.0)),
          children =
            listOf(
              OverlayBoxNode(testTag = "a", style = weighted, children = emptyList()),
              OverlayBoxNode(
                testTag = "b",
                style = weighted.copy(weight = 2.0),
                children = emptyList(),
              ),
            ),
        )
      )
    assertEquals(dp(40f), root.tagged("a").boundsInRoot.height, 0.5f)
    assertEquals(dp(80f), root.tagged("b").boundsInRoot.height, 0.5f)
  }

  @Test
  fun `min and max bounds clamp the authored size`() {
    val root =
      render(
        OverlayColumnNode(
          children =
            listOf(
              OverlayBoxNode(
                testTag = "maxFill",
                style =
                  OverlayStyle(
                    width = OverlayDimension.Fill,
                    maxWidth = 50.0,
                    height = OverlayDimension.Dp(10.0),
                  ),
                children = emptyList(),
              ),
              OverlayBoxNode(
                testTag = "minDp",
                style =
                  OverlayStyle(
                    width = OverlayDimension.Dp(10.0),
                    minWidth = 80.0,
                    height = OverlayDimension.Dp(10.0),
                  ),
                children = emptyList(),
              ),
              OverlayBoxNode(
                testTag = "maxDp",
                style =
                  OverlayStyle(
                    width = OverlayDimension.Dp(10.0),
                    height = OverlayDimension.Dp(200.0),
                    maxHeight = 40.0,
                  ),
                children = emptyList(),
              ),
            )
        )
      )
    assertEquals(dp(50f), root.tagged("maxFill").boundsInRoot.width, 0.5f)
    assertEquals(dp(80f), root.tagged("minDp").boundsInRoot.width, 0.5f)
    assertEquals(dp(40f), root.tagged("maxDp").boundsInRoot.height, 0.5f)
  }

  @Test
  fun `an icon-only tappable container is labelled by its icon, not its kind`() {
    val root =
      render(
        OverlayColumnNode(
          children =
            listOf(
              OverlayBoxNode(
                testTag = "fab",
                onTap = tap,
                children = listOf(OverlayIconNode(name = "add")),
              ),
              OverlayRowNode(
                testTag = "settings",
                onTap = tap,
                children = listOf(OverlayIconNode(name = "settings")),
              ),
              OverlayRowNode(
                testTag = "save",
                onTap = tap,
                children = listOf(OverlayIconNode(name = "save"), OverlayTextNode(text = "Save")),
              ),
            )
        )
      )
    fun label(tag: String) =
      root.tagged(tag).config.getOrElseNullable(SemanticsProperties.ContentDescription) { null }
    assertEquals(listOf("add"), label("fab"))
    assertEquals(listOf("settings"), label("settings"))
    // Mixed content labels the container through its children, never as "row".
    assertNull(label("save"))
  }

  @Test
  fun `plain text inherits the theme font family unless it names its own`() {
    val root =
      render(
        OverlayColumnNode(
          children =
            listOf(
              OverlayTextNode(text = "Plain"),
              OverlayTextNode(
                text = "Mono",
                style = OverlayStyle(fontFamily = OverlayFontFamily.Named("monospace")),
              ),
            )
        ),
        OverlaySpecTheme(typography = OverlaySpecThemeTypography(fontFamily = "serif")),
      )
    assertEquals(FontFamily.Serif, root.textStyleOf("Plain").fontFamily)
    assertEquals(FontFamily.Monospace, root.textStyleOf("Mono").fontFamily)
  }
}
