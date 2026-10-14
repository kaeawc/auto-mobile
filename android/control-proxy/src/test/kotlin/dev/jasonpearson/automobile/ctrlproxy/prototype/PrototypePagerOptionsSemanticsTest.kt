package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Render in setup; the timed assertions inspect only accessibility traversal snapshots. */
@RunWith(RobolectricTestRunner::class)
class PrototypePagerOptionsSemanticsTest {
  private lateinit var visible: Map<String, List<Int>>
  private lateinit var selected: Map<String, Map<Int, Boolean>>
  private lateinit var selectedNodeCounts: Map<String, Int>

  @Before
  fun renderPages() {
    val visibility = mutableMapOf<String, List<Int>>()
    val selection = mutableMapOf<String, Map<Int, Boolean>>()
    val selectionCounts = mutableMapOf<String, Int>()
    for (axis in listOf("horizontal", "vertical")) {
      for (mode in listOf("fixed", "peek", "plain")) {
        val key = "$axis-$mode"
        val root =
          PrototypePagerNode(
            id = "pages",
            axis = axis,
            peek = if (mode == "peek") PrototypePagerPeek(end = 20.0) else null,
            pageSize = if (mode == "fixed") PrototypePagerPageSize.Dp(100.0) else null,
            style =
              PrototypeStyle(
                width = PrototypeDimension.Dp(300.0),
                height = PrototypeDimension.Dp(300.0),
              ),
            children =
              List(5) { page ->
                PrototypeColumnNode(
                  children = listOf(PrototypeButtonNode(label = "Page $page")),
                )
              },
          )
        PrototypeSemanticsRender(semanticsSpec(root)).use { render ->
          selectionCounts[key] =
            render.nodes.count {
              it.config.getOrNull(SemanticsProperties.Selected) != null
            }
          visibility[key] =
            (0..4).filter { page ->
              render.nodes.any { it.hasExactPrototypeText("Page $page") }
            }
          selection[key] =
            render.nodes
              .mapNotNull { container ->
                val isSelected =
                  container.config.getOrNull(SemanticsProperties.Selected) ?: return@mapNotNull null
                val page =
                  (0..4).firstOrNull { page ->
                    container.accessibilityNodes().any { it.hasExactPrototypeText("Page $page") }
                  } ?: return@mapNotNull null
                page to isSelected
              }
              .toMap()
        }
      }
    }
    visible = visibility
    selected = selection
    selectedNodeCounts = selectionCounts
  }

  @Test
  fun `fixed pages on both axes expose every visible page and only current is selected`() {
    for (axis in listOf("horizontal", "vertical")) {
      assertEquals(listOf(0, 1, 2), visible.getValue("$axis-fixed"))
      assertEquals(mapOf(0 to true, 1 to false, 2 to false), selected.getValue("$axis-fixed"))
    }
  }

  @Test
  fun `peek on both axes exposes the partly visible next page but no offscreen pages`() {
    for (axis in listOf("horizontal", "vertical")) {
      assertEquals(listOf(0, 1), visible.getValue("$axis-peek"))
      assertEquals(mapOf(0 to true, 1 to false), selected.getValue("$axis-peek"))
    }
  }

  @Test
  fun `plain pager on both axes exposes only current page without selected semantics nodes`() {
    for (axis in listOf("horizontal", "vertical")) {
      assertEquals(listOf(0), visible.getValue("$axis-plain"))
      assertEquals(emptyMap<Int, Boolean>(), selected.getValue("$axis-plain"))
      assertEquals(0, selectedNodeCounts.getValue("$axis-plain"))
    }
  }
}
