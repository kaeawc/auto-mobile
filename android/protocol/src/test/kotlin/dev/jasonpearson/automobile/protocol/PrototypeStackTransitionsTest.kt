package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class PrototypeStackTransitionsTest {
  private fun spec(transition: String = "", actions: String = "") =
    """{"id":"a","window":{"placement":{"type":"fullscreen"}},"root":{"type":"stack","id":"nav","start":"home"$transition,"screens":{"home":{"type":"text","text":"x"$actions}}}}"""

  // Initialise the shared contract, serializers and bundle validator outside per-test timing.
  @BeforeAll
  fun prepareValidators() {
    val json =
      spec(
        ",\"transition\":\"platform\"",
        actions =
          """, "onTap":[{"type":"push","stack":"nav","screen":"home","transition":"fade"}]""",
      )
    PrototypeSpecValidator.validate(json)
    PrototypeSpecValidator.validate(json, supportedCapabilities = setOf("prototype_stack_v1"))
    PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(json.toByteArray()))
    assertTransition(PrototypeStackTransition.PLATFORM)
  }

  @Test
  fun `enum matches the shared contract`() {
    val values =
      PrototypeSpecContract.definitions.getValue("stackTransition").jsonObject.getValue("values")
    assertEquals(
      Json.parseToJsonElement(
        PrototypeStackTransition.entries.joinToString(prefix = "[", postfix = "]") {
          "\"${it.value}\""
        },
      ),
      values,
    )
  }

  @Test
  fun `platform decodes on stacks and actions`() =
    assertTransition(PrototypeStackTransition.PLATFORM)

  @Test
  fun `slide decodes on stacks and actions`() = assertTransition(PrototypeStackTransition.SLIDE)

  @Test fun `fade decodes on stacks and actions`() = assertTransition(PrototypeStackTransition.FADE)

  @Test fun `none decodes on stacks and actions`() = assertTransition(PrototypeStackTransition.NONE)

  private fun assertTransition(transition: PrototypeStackTransition) {
    val action =
      """, "onTap":[{"type":"push","stack":"nav","screen":"home","transition":"${transition.value}"},{"type":"replace","stack":"nav","screen":"home","transition":"${transition.value}"}]"""
    val result =
      PrototypeSpecValidator.validate(spec(",\"transition\":\"${transition.value}\"", action))
    assertTrue(result is PrototypeSpecValidation.Success, result.toString())
    val root = (result as PrototypeSpecValidation.Success).spec.root as PrototypeStackNode
    assertEquals(transition, root.stackTransition)
    assertEquals(
      transition,
      (root.screens.getValue("home").onTap!![0] as PrototypePushAction).transition,
    )
    assertEquals(
      transition,
      (root.screens.getValue("home").onTap!![1] as PrototypeReplaceAction).transition,
    )
  }

  private fun transitionSpec(action: Boolean) =
    if (action)
      spec(
        actions =
          """, "onTap":[{"type":"push","stack":"nav","screen":"home","transition":"fade"}]""",
      )
    else spec(",\"transition\":\"platform\"")

  @Test
  fun `stack strict and bundle scans require the new gate only`() = assertScannedCapabilities(false)

  @Test
  fun `action strict and bundle scans require the new gate only`() = assertScannedCapabilities(true)

  private fun assertScannedCapabilities(action: Boolean) {
    val json = transitionSpec(action)
    assertEquals(
      setOf("prototype_stack_v1", "prototype_stack_transitions_v1"),
      PrototypeStrictPolicy.required(Json.parseToJsonElement(json).jsonObject),
    )
    assertEquals(
      listOf("prototype_stack_transitions_v1", "prototype_stack_v1"),
      PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(json.toByteArray())),
    )
  }

  @Test fun `stack missing capability fails closed`() = assertMissingCapability(false)

  @Test fun `action missing capability fails closed`() = assertMissingCapability(true)

  private fun assertMissingCapability(action: Boolean) {
    assertTrue(
      PrototypeSpecValidator.validate(
        transitionSpec(action),
        supportedCapabilities = setOf("prototype_stack_v1"),
      ) is PrototypeSpecValidation.Failure,
    )
  }

  @Test fun `stack provided capability accepts`() = assertProvidedCapability(false)

  @Test fun `action provided capability accepts`() = assertProvidedCapability(true)

  private fun assertProvidedCapability(action: Boolean) {
    assertTrue(
      PrototypeSpecValidator.validate(
        transitionSpec(action),
        supportedCapabilities = setOf("prototype_stack_v1", "prototype_stack_transitions_v1"),
      ) is PrototypeSpecValidation.Success,
    )
  }

  @Test
  fun `omitted transition needs no new capability`() {
    assertEquals(
      setOf("prototype_stack_v1"),
      PrototypeStrictPolicy.required(Json.parseToJsonElement(spec()).jsonObject),
    )
  }

  @Test fun `scale is not a stack transition`() = assertInvalidTransition("\"scale\"")

  @Test fun `future patterns are not enabled`() = assertInvalidTransition("\"sharedAxisX\"")

  @Test
  fun `visibility objects are not stack transitions`() =
    assertInvalidTransition("{\"type\":\"fade\"}")

  @Test fun `null is not a stack transition`() = assertInvalidTransition("null")

  private fun assertInvalidTransition(bad: String) {
    assertTrue(
      PrototypeSpecValidator.validate(spec(""","transition":$bad"""))
        is PrototypeSpecValidation.Failure,
    )
    for (type in listOf("push", "replace")) {
      assertTrue(
        PrototypeSpecValidator.validate(
          spec(
            actions =
              ""","onTap":[{"type":"$type","stack":"nav","screen":"home","transition":$bad}]""",
          ),
        ) is PrototypeSpecValidation.Failure,
      )
    }
  }

  @Test fun `pop overrides are rejected`() = assertPopOverride("pop")

  @Test fun `popToRoot overrides are rejected`() = assertPopOverride("popToRoot")

  private fun assertPopOverride(type: String) {
    assertTrue(
      PrototypeSpecValidator.validate(
        spec(actions = ""","onTap":[{"type":"$type","stack":"nav","transition":"none"}]"""),
      ) is PrototypeSpecValidation.Failure,
    )
  }
}
