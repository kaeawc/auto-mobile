package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeSwipeActionsSpecTest {
  private val action =
    """{"label":"Delete","role":"destructive","onTap":[{"type":"emit","name":"d"}]}"""

  private fun spec(root: String) =
    """{"id":"s","window":{"placement":{"type":"fullscreen"}},"root":$root}"""

  private fun item(swipe: String) =
    """{"type":"listItem","headline":"Order","swipeActions":$swipe}"""

  private fun failure(root: String) =
    (PrototypeSpecValidator.validate(spec(root)) as PrototypeSpecValidation.Failure).error.path

  @Test
  fun `row and listItem decode their swipe actions`() {
    val list =
      Json.decodeFromString(
          PrototypeSpec.serializer(),
          spec(
            item(
              """{"start":[{"label":"Pin","icon":"favorite","onTap":[{"type":"emit","name":"p"}]}],"end":[$action],"fullSwipe":true}""",
            ),
          ),
        )
        .root as PrototypeListItemNode
    assertEquals("Pin", list.swipeActions?.start?.single()?.label)
    assertEquals("destructive", list.swipeActions?.end?.single()?.role)
    assertEquals(true, list.swipeActions?.fullSwipe)
    val row =
      Json.decodeFromString(
          PrototypeSpec.serializer(),
          spec("""{"type":"row","children":[],"swipeActions":{"end":[$action]}}"""),
        )
        .root as PrototypeRowNode
    assertEquals(1, row.swipeActions?.end?.size)
  }

  @Test
  fun `a swipe needs a side and each side holds one to three entries`() {
    assertEquals(
      "root.children[0].swipeActions",
      failure("""{"type":"column","children":[${item("{}")}]}"""),
    )
    val four = List(4) { action }.joinToString(",")
    assertEquals(
      "root.children[0].swipeActions.start",
      failure("""{"type":"column","children":[${item("""{"start":[$four]}""")}]}"""),
    )
    assertEquals(
      "root.children[0].swipeActions.end[0].onTap",
      failure(
        """{"type":"column","children":[${item("""{"end":[{"label":"x","onTap":[]}]}""")}]}""",
      ),
    )
  }

  @Test
  fun `horizontal pagers and carousels refuse swipe actions and a vertical pager allows them`() {
    val inner = """{"type":"column","children":[${item("""{"end":[$action]}""")}]}"""
    val path = "root.children[0].children[0].swipeActions"
    assertEquals(path, failure("""{"type":"pager","id":"p","children":[$inner]}"""))
    assertEquals(
      path,
      failure("""{"type":"pager","id":"p","axis":"horizontal","children":[$inner]}"""),
    )
    assertEquals(
      path,
      failure("""{"type":"carousel","itemWidth":100,"children":[$inner]}"""),
    )
    assertTrue(
      PrototypeSpecValidator.validate(
        spec("""{"type":"pager","id":"p","axis":"vertical","children":[$inner]}"""),
      ) is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun `repeat instances bind swipe labels and actions`() {
    val root =
      """{"type":"column","repeat":{"as":"o","items":[{"id":"a"}]},"children":[{"type":"listItem","headline":"x","swipeActions":{"end":[{"label":"Del {o.id}","onTap":[{"type":"emit","name":"del_{o.id}"}]}]}}]}"""
    assertTrue(PrototypeSpecValidator.validate(spec(root)) is PrototypeSpecValidation.Success)
    assertEquals(
      "root.children[0].swipeActions.end[0].onTap[0].name",
      failure(root.replace("del_{o.id}", "del_{o.missing}")),
    )
  }
}
