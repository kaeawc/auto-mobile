package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeWindowMotionContractTest {
  private val spec =
    """{"id":"a","window":{"placement":{"type":"fullscreen"},"transition":"fade"},"root":{"type":"column","repeat":{"items":[{"n":"A"}],"as":"item","stagger":100},"children":[{"type":"text","text":"A"}]}}"""

  companion object {
    @JvmStatic
    @BeforeAll
    fun warmContract() {
      val result =
        PrototypeSpecValidator.validate(PrototypeWindowMotionContractTest().spec)
          as PrototypeSpecValidation.Success
      val encoded = Json.encodeToString(PrototypeSpec.serializer(), result.spec)
      val decoded = PrototypeSpecValidator.validate(encoded) as PrototypeSpecValidation.Success
      assertEquals(result.spec, decoded.spec)
      assertEquals(
        setOf("prototype_window_motion_v1"),
        PrototypeStrictPolicy.required(Json.parseToJsonElement(encoded).jsonObject),
      )
    }
  }

  @Test
  fun `window transition and repeat stagger survive decode encode and capability scan`() {
    val result = PrototypeSpecValidator.validate(spec) as PrototypeSpecValidation.Success
    assertEquals("fade", result.spec.window.transition)
    assertEquals(100, (result.spec.root as PrototypeColumnNode).repeat!!.stagger)
    val encoded = Json.encodeToString(PrototypeSpec.serializer(), result.spec)
    val again = PrototypeSpecValidator.validate(encoded) as PrototypeSpecValidation.Success
    assertEquals(result.spec, again.spec)
    assertEquals(
      setOf("prototype_window_motion_v1"),
      PrototypeStrictPolicy.required(Json.parseToJsonElement(spec).jsonObject),
    )
  }

  @Test
  fun `strict policy refuses missing capability and validates stagger range`() {
    assertTrue(
      PrototypeSpecValidator.validate(spec, supportedCapabilities = emptySet())
        is PrototypeSpecValidation.Failure,
    )
    assertTrue(
      PrototypeSpecValidator.validate(
        spec,
        supportedCapabilities = setOf("prototype_window_motion_v1"),
      ) is PrototypeSpecValidation.Success,
    )
    for (value in listOf("-1", "101", "0.5")) {
      assertTrue(
        PrototypeSpecValidator.validate(spec.replace("\"stagger\":100", "\"stagger\":$value"))
          is PrototypeSpecValidation.Failure,
      )
    }
  }
}
