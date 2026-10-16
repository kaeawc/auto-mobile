package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PrototypeCarouselTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmMapping() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private fun spec(root: PrototypeNode) =
    PrototypeSpec("panel", PrototypeWindow(PrototypeFullscreenPlacement()), root = root)

  @Test
  fun `a horizontal indicator centres the dots near the bottom edge`() {
    val dots = pagerIndicatorDots(3, false, 200f, 100f, 3f, 8f, 8f)
    assertEquals(listOf(86f, 100f, 114f), dots.map { it.x })
    assertTrue(dots.all { it.y == 89f })
  }

  @Test
  fun `a vertical indicator stacks the dots near the end edge`() {
    val dots = pagerIndicatorDots(2, true, 200f, 100f, 3f, 8f, 8f)
    assertEquals(listOf(43f, 57f), dots.map { it.y })
    assertTrue(dots.all { it.x == 189f })
    assertEquals(emptyList<PrototypeDot>(), pagerIndicatorDots(0, false, 200f, 100f, 3f, 8f, 8f))
  }

  @Test
  fun `a single page draws one centred dot`() {
    assertEquals(
      listOf(PrototypeDot(100f, 89f)),
      pagerIndicatorDots(1, false, 200f, 100f, 3f, 8f, 8f),
    )
  }

  @Test
  fun `a carousel maps to its own role and keeps every item in the render tree`() {
    val items =
      List(3) { PrototypeCardNode(children = listOf(PrototypeTextNode(text = "item $it"))) }
    val node =
      PrototypeCarouselNode(variant = "hero", itemWidth = 120.0, children = items, testTag = "rail")
    val mapped = mapPrototypeSpec(spec(node)).root
    assertEquals("carousel", mapped.role)
    assertEquals("rail", mapped.testTag)
    assertEquals(3, mapped.children.size)
  }

  @Test
  fun `a carousel repeat instantiates its template once per item`() {
    val node =
      PrototypeCarouselNode(
        itemWidth = 100.0,
        repeat =
          PrototypeRepeat(
            items =
              listOf(
                mapOf("t" to PrototypeScalar.Text("a")),
                mapOf("t" to PrototypeScalar.Text("b")),
              ),
            `as` = "item",
          ),
        children = listOf(PrototypeTextNode(text = "{item.t}")),
      )
    assertEquals(listOf("a", "b"), mapPrototypeSpec(spec(node)).root.children.map { it.text })
  }
}
