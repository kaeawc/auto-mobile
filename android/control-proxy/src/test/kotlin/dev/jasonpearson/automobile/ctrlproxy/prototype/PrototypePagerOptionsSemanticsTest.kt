package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Render in setup; the timed assertions inspect only the accessibility traversal. */
@RunWith(RobolectricTestRunner::class)
class PrototypePagerOptionsSemanticsTest {
  private lateinit var labels: Map<String, List<String>>

  @Before
  fun renderPeekPages() {
    labels =
      listOf("horizontal", "vertical").associateWith { axis ->
        val root =
          PrototypePagerNode(
            id = "pages",
            axis = axis,
            peek = PrototypePagerPeek(20.0, 20.0),
            pageSpacing = 8.0,
            pageSize = PrototypePagerPageSize.Dp(120.0),
            style =
              PrototypeStyle(
                width = PrototypeDimension.Dp(300.0),
                height = PrototypeDimension.Dp(240.0),
              ),
            children =
              List(3) { page ->
                PrototypeColumnNode(
                  children = listOf(PrototypeButtonNode(label = "Page $page")),
                )
              },
          )
        PrototypeSemanticsRender(semanticsSpec(root)).use { render ->
          (0..2)
            .filter { page ->
              render.nodes.any { it.hasExactPrototypeText("Page $page") }
            }
            .map { "Page $it" }
        }
      }
  }

  @Test
  fun `horizontal peek neighbours stay outside accessibility semantics`() {
    assertEquals(listOf("Page 0"), labels.getValue("horizontal"))
  }

  @Test
  fun `vertical peek neighbours stay outside accessibility semantics`() {
    assertEquals(listOf("Page 0"), labels.getValue("vertical"))
  }
}
