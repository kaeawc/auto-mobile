package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class PrototypeTooltipDrawerSpecTest {
  private fun spec(node: String) =
    """{"id":"hint","window":{"placement":{"type":"fullscreen"}},"state":{"open":true},"root":$node}"""

  private val tooltip =
    """{"type":"tooltip","text":"Help","anchor":{"type":"bounds","bounds":{"x":0,"y":0,"width":40,"height":40}},"openWhen":{"key":"open","equals":true}}"""
  private val drawer =
    """{"type":"drawer","edge":"start","openWhen":{"key":"open","equals":true},"child":{"type":"text","text":"Navigation"}}"""

  @BeforeAll
  fun warmup() {
    PrototypeSpecValidator.validate(spec(tooltip))
  }

  @Test
  fun `tooltip decodes and requires its capability`() =
    checkCapability(tooltip, "prototype_tooltip_v1")

  @Test
  fun `drawer decodes and requires its capability`() =
    checkCapability(drawer, "prototype_drawer_v1")

  private fun checkCapability(node: String, capability: String) {
    assertTrue(PrototypeSpecValidator.validate(spec(node)) is PrototypeSpecValidation.Success)
    assertTrue(
      PrototypeSpecValidator.validate(spec(node), supportedCapabilities = emptySet())
        is PrototypeSpecValidation.Failure,
    )
    assertTrue(
      PrototypeSpecValidator.validate(spec(node), supportedCapabilities = setOf(capability))
        is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun `unknown target reports the authored field`() {
    val node =
      """{"type":"tooltip","text":"Help","anchorTo":"missing","openWhen":{"key":"open","equals":true}}"""
    val result = PrototypeSpecValidator.validate(spec(node)) as PrototypeSpecValidation.Failure
    assertEquals("root.anchorTo", result.error.path)
    assertEquals("Unknown anchorTo id \"missing\"", result.error.message)
  }

  @Test
  fun `duplicate target reports the authored field`() {
    val node =
      """{"type":"column","children":[{"type":"text","id":"target","text":"a"},{"type":"text","id":"target","text":"b"},{"type":"tooltip","text":"Help","anchorTo":"target","openWhen":{"key":"open","equals":true}}]}"""
    val result = PrototypeSpecValidator.validate(spec(node)) as PrototypeSpecValidation.Failure
    assertEquals("root.children[2].anchorTo", result.error.path)
    assertEquals("Duplicate anchorTo id \"target\"", result.error.message)
  }

  @Test
  fun `modal state must be boolean`() {
    for ((node, name) in listOf(tooltip to "Tooltip", drawer to "Drawer")) {
      val result =
        PrototypeSpecValidator.validate(spec(node).replace("\"open\":true", "\"open\":3"))
          as PrototypeSpecValidation.Failure
      assertEquals("root.openWhen.key", result.error.path)
      assertEquals("$name requires a boolean state key", result.error.message)
    }
  }

  @Test
  fun `bundle scanner requires both capability flags`() {
    for ((node, flag) in
      listOf(tooltip to "prototype_tooltip_v1", drawer to "prototype_drawer_v1")) {
      assertEquals(
        setOf(flag),
        PrototypeStrictPolicy.required(Json.parseToJsonElement(spec(node)).jsonObject),
      )
      assertEquals(
        listOf(flag),
        PrototypeBundleCapabilities.required(
          PrototypeBundleSpec.references(spec(node).toByteArray()),
        ),
      )
    }
  }
}
