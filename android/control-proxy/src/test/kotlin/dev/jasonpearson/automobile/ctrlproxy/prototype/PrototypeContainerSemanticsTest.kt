package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.node.RootForTest
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/** The accessibility tree observe reads for layout containers and authored labels (#10446). */
@RunWith(RobolectricTestRunner::class)
class PrototypeContainerSemanticsTest {
  private val save = listOf<PrototypeAction>(PrototypeEmitAction("save"))

  private fun render(root: PrototypeNode, state: Map<String, PrototypeScalar> = emptyMap()) = run {
    val spec = PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), state, root)
    val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    activity.setContent { PrototypeSpecContent(mapPrototypeSpec(spec).root) }
    shadowOf(Looper.getMainLooper()).idle()
    val view = checkNotNull(composeView(activity.window.decorView))
    (view as RootForTest).semanticsOwner.unmergedRootSemanticsNode
  }

  private fun composeView(view: View): View? =
    if (view is RootForTest) view
    else if (view is ViewGroup)
      (0 until view.childCount).firstNotNullOfOrNull { composeView(view.getChildAt(it)) }
    else null

  private fun SemanticsNode.all(): List<SemanticsNode> =
    listOf(this) + children.flatMap { it.all() }

  private fun SemanticsNode.tagged(tag: String): SemanticsNode =
    checkNotNull(all().find { it.config.getOrNull(SemanticsProperties.TestTag) == tag }) {
      "no node tagged $tag"
    }

  private fun SemanticsNode.kinds(): List<String> =
    all().mapNotNull { it.config.getOrNull(PrototypeRole) }

  @Test
  fun `layout containers with nothing to report are merged into their parent`() {
    val root =
      render(
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeRowNode(
                children =
                  listOf(
                    PrototypeBoxNode(
                      children = listOf(PrototypeTextNode(testTag = "t", text = "Hi")),
                    ),
                  ),
              ),
            ),
        ),
      )

    assertEquals(listOf("text"), root.kinds())
    // The text's nearest semantics ancestor is the content root, not an empty column/row/box.
    val text = root.tagged("t")
    assertNull(text.parent?.config?.getOrNull(PrototypeRole))
  }

  @Test
  fun `containers with a test tag, a tap, a label or state keep their node`() {
    val root =
      render(
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeBoxNode(testTag = "tagged", children = emptyList()),
              PrototypeRowNode(
                onTap = save,
                children = listOf(PrototypeTextNode(text = "Open")),
              ),
              PrototypeBoxNode(
                contentDescription = "Banner",
                children = listOf(PrototypeTextNode(text = "Sale")),
              ),
            ),
        ),
      )

    assertEquals(listOf("box", "row", "text", "box", "text"), root.kinds())
    val banner =
      root.all().first {
        it.config.getOrNull(SemanticsProperties.ContentDescription) == listOf("Banner")
      }
    assertEquals("box", banner.config[PrototypeRole])
  }

  @Test
  fun `an authored content description replaces the derived label`() {
    val root =
      render(
        PrototypeColumnNode(
          children =
            listOf(
              PrototypeIconNode(
                testTag = "fav",
                name = "favorite",
                contentDescription = "Favourite",
              ),
              PrototypeButtonNode(
                testTag = "save",
                label = "Save",
                contentDescription = "Save {count} drafts",
                onTap = save,
              ),
            ),
        ),
        mapOf("count" to PrototypeScalar.Numeric(3.0)),
      )

    assertEquals(
      listOf("Favourite"),
      root.tagged("fav").config[SemanticsProperties.ContentDescription],
    )
    assertEquals(
      listOf("Save 3 drafts"),
      root.tagged("save").config[SemanticsProperties.ContentDescription],
    )
  }

  @Test
  fun `a tab bar is labelled by its tabs, which report role and selected state`() {
    val root =
      render(
        PrototypeTabBarNode(
          testTag = "tabs",
          items = listOf(PrototypeItem("Home"), PrototypeItem("Search")),
          stateKey = "tab",
        ),
        mapOf("tab" to PrototypeScalar.Numeric(1.0)),
      )

    val tabs = root.tagged("tabs")
    assertNull(tabs.config.getOrNull(SemanticsProperties.ContentDescription))
    val tabNodes = root.all().filter { it.config.getOrNull(SemanticsProperties.Role) == Role.Tab }
    assertEquals(2, tabNodes.size)
    assertEquals(listOf(false, true), tabNodes.map { it.config[SemanticsProperties.Selected] })
    assertTrue(tabNodes.all { it.config.contains(SemanticsProperties.Role) })
  }
}
