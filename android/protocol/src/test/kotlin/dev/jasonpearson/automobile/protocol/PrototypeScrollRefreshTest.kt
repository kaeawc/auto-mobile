package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeScrollRefreshTest {
  private fun spec(scroll: String, state: String = """{"busy":false}""") =
    """{"id":"r","window":{"placement":{"type":"fullscreen"}},"state":$state,"root":$scroll}"""

  private fun scroll(extra: String = "", refresh: String = REFRESH) =
    """{"type":"scroll",$extra"refresh":$refresh,"child":{"type":"text","text":"x"}}"""

  private fun failure(input: String) =
    (PrototypeSpecValidator.validate(input) as PrototypeSpecValidation.Failure).error.path

  @Test
  fun `refresh decodes to the model with its key and actions`() {
    val node = Json.decodeFromString(PrototypeSpec.serializer(), spec(scroll())).root
    assertEquals(
      PrototypeScrollRefresh("busy", listOf(PrototypeEmitAction("reload"))),
      (node as PrototypeScrollNode).refresh,
    )
  }

  @Test
  fun `a vertical scroll with a boolean key is valid and a horizontal one is not`() {
    assertTrue(PrototypeSpecValidator.validate(spec(scroll())) is PrototypeSpecValidation.Success)
    assertEquals("root.refresh", failure(spec(scroll("\"axis\":\"horizontal\","))))
  }

  @Test
  fun `a declared non boolean key and an empty action list are refused at their paths`() {
    assertEquals("root.refresh.stateKey", failure(spec(scroll(), """{"busy":"yes"}""")))
    assertEquals(
      "root.refresh.onRefresh",
      failure(spec(scroll(refresh = """{"stateKey":"busy","onRefresh":[]}"""))),
    )
  }

  @Test
  fun `repeat instances bind the refresh key and actions like onTap`() {
    val input =
      """{"id":"r","window":{"placement":{"type":"fullscreen"}},"state":{"busy_a":false},"root":{"type":"column","repeat":{"as":"item","items":[{"id":"a"}]},"children":[{"type":"scroll","refresh":{"stateKey":"busy_{item.id}","onRefresh":[{"type":"emit","name":"reload_{item.id}"}]},"child":{"type":"text","text":"x"}}]}}"""
    assertTrue(PrototypeSpecValidator.validate(input) is PrototypeSpecValidation.Success)
    assertEquals(
      "root.children[0].refresh.onRefresh[0].name",
      failure(input.replace("reload_{item.id}", "reload_{item.missing}")),
    )
  }

  private companion object {
    const val REFRESH = """{"stateKey":"busy","onRefresh":[{"type":"emit","name":"reload"}]}"""
  }
}
