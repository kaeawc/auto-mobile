package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeCarouselSpecTest {
  private fun spec(root: String) =
    """{"id":"c","window":{"placement":{"type":"fullscreen"}},"root":$root}"""

  private val card = """{"type":"card","children":[{"type":"text","text":"x"}]}"""

  private fun failure(root: String) =
    (PrototypeSpecValidator.validate(spec(root)) as PrototypeSpecValidation.Failure).error.path

  @Test
  fun `carousel decodes its variant width spacing and items`() {
    val root =
      Json.decodeFromString(
          PrototypeSpec.serializer(),
          spec(
            """{"type":"carousel","variant":"hero","itemWidth":280,"itemSpacing":8,"children":[$card]}""",
          ),
        )
        .root as PrototypeCarouselNode
    assertEquals("hero", root.variant)
    assertEquals(280.0, root.itemWidth, 0.0)
    assertEquals(8.0, root.itemSpacing!!, 0.0)
    assertEquals(1, root.children.size)
  }

  @Test
  fun `pager indicator decodes and an unknown one is refused`() {
    val pager =
      Json.decodeFromString(
          PrototypeSpec.serializer(),
          spec("""{"type":"pager","id":"p","indicator":"dots","children":[$card]}"""),
        )
        .root as PrototypePagerNode
    assertEquals("dots", pager.indicator)
    assertEquals(
      "root.indicator",
      failure("""{"type":"pager","id":"p","indicator":"bars","children":[$card]}"""),
    )
  }

  @Test
  fun `carousel refuses missing width no items and an unknown variant at their paths`() {
    assertEquals("root.itemWidth", failure("""{"type":"carousel","children":[$card]}"""))
    assertEquals(
      "root.itemWidth",
      failure("""{"type":"carousel","itemWidth":0,"children":[$card]}"""),
    )
    assertEquals("root.children", failure("""{"type":"carousel","itemWidth":10,"children":[]}"""))
    assertEquals(
      "root.variant",
      failure("""{"type":"carousel","itemWidth":10,"variant":"coverflow","children":[$card]}"""),
    )
  }
}
