package dev.jasonpearson.automobile.protocol

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeBarScrollTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warmValidator() {
      check(
        PrototypeSpecValidator.validate(PrototypeBarScrollTest().spec())
          is PrototypeSpecValidation.Success,
      )
    }
  }

  private fun spec(behavior: String = "exitUntilCollapsed", target: String = "feed") =
    """{"id":"bars","window":{"placement":{"type":"fullscreen"}},"root":{"type":"column","children":[{"type":"topAppBar","title":"Feed","variant":"large","onScroll":"$behavior","scroll":"$target"},{"type":"scroll","id":"feed","child":{"type":"text","text":"Feed"}}]}}"""

  @Test
  fun `bar scroll behavior validates and decodes`() {
    val result = PrototypeSpecValidator.validate(spec()) as PrototypeSpecValidation.Success
    val bar = (result.spec.root as PrototypeColumnNode).children.first() as PrototypeTopAppBarNode
    assertEquals("exitUntilCollapsed", bar.onScroll)
    assertEquals("feed", bar.scroll)
  }

  @Test
  fun `invalid enum and missing scroll rejected at authored path`() {
    val invalid =
      PrototypeSpecValidator.validate(spec("invalid")) as PrototypeSpecValidation.Failure
    assertEquals("root.children[0].onScroll", invalid.error.path)
    val missing =
      PrototypeSpecValidator.validate(spec(target = "absent")) as PrototypeSpecValidation.Failure
    assertEquals("root.children[0].scroll", missing.error.path)
  }
}
