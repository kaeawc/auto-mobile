package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeTextFieldActionsSpecTest {
  private fun spec(field: String, state: String = """{"q":"x"}""") =
    """{"id":"t","window":{"placement":{"type":"fullscreen"}},"state":$state,"root":{"type":"textField","stateKey":"q",$field}}"""

  private fun failure(input: String) =
    (PrototypeSpecValidator.validate(input) as PrototypeSpecValidation.Failure).error.path

  @Test
  fun `trailing icon IME action and submit actions decode`() {
    val node =
      Json.decodeFromString(
          PrototypeSpec.serializer(),
          spec(
            """"trailingIcon":{"icon":"close","label":"Clear","onTap":[{"type":"emit","name":"c"}]},"imeAction":"search","onSubmit":[{"type":"emit","name":"s"}]""",
          ),
        )
        .root as PrototypeTextFieldNode
    assertEquals("close", node.trailingIcon?.icon)
    assertEquals("Clear", node.trailingIcon?.label)
    assertEquals("search", node.imeAction)
    assertEquals(listOf(PrototypeEmitAction("s")), node.onSubmit)
  }

  @Test
  fun `multiline refuses the IME fields and bad values fail at their paths`() {
    assertEquals("root.imeAction", failure(spec(""""multiline":true,"imeAction":"done"""")))
    assertEquals(
      "root.onSubmit",
      failure(spec(""""multiline":true,"onSubmit":[{"type":"emit","name":"x"}]""")),
    )
    assertEquals("root.imeAction", failure(spec(""""imeAction":"previous"""")))
    assertEquals("root.trailingIcon.label", failure(spec(""""trailingIcon":{"icon":"close"}""")))
    assertEquals("root.onSubmit", failure(spec(""""onSubmit":[]""")))
  }

  @Test
  fun `repeat instances bind the trailing icon and submit actions`() {
    val input =
      """{"id":"t","window":{"placement":{"type":"fullscreen"}},"state":{"q_a":"x"},"root":{"type":"column","repeat":{"as":"item","items":[{"id":"a"}]},"children":[{"type":"textField","stateKey":"q_{item.id}","trailingIcon":{"icon":"close","label":"Clear","onTap":[{"type":"setState","key":"q_{item.id}","value":""}]},"onSubmit":[{"type":"emit","name":"s_{item.id}"}]}]}}"""
    assertTrue(PrototypeSpecValidator.validate(input) is PrototypeSpecValidation.Success)
    assertEquals(
      "root.children[0].onSubmit[0].name",
      failure(input.replace("s_{item.id}", "s_{item.missing}")),
    )
  }
}
