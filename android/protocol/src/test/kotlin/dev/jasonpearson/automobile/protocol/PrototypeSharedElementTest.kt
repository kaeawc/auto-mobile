package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeSharedElementTest {
  @Test
  fun `shared nodes decode keys and both capability scanners agree`() {
    val input = fixtureDirectory().resolve("valid/shared-element.json").readText()
    val result = PrototypeSpecValidator.validate(input)
    assertTrue(result is PrototypeSpecValidation.Success, result.toString())
    val spec = Json.parseToJsonElement(input).jsonObject
    assertTrue("prototype_shared_element_v1" in PrototypeStrictPolicy.required(spec))
    assertTrue(
      "prototype_shared_element_v1" in
        PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(input.toByteArray())),
    )
    val encoded =
      Json.encodeToString(
        PrototypeSpec.serializer(),
        (result as PrototypeSpecValidation.Success).spec,
      )
    assertTrue(encoded.contains("sharedKey"))
    assertTrue(
      PrototypeSpecValidator.validate(input, supportedCapabilities = emptySet())
        is PrototypeSpecValidation.Failure,
    )
  }

  @Test
  fun `reduced motion requires its own gate in strict and bundle scans`() {
    val input = fixtureDirectory().resolve("valid/reduced-motion.json").readText()
    val spec = Json.parseToJsonElement(input).jsonObject
    assertTrue("prototype_reduced_motion_v1" in PrototypeStrictPolicy.required(spec))
    assertTrue(
      "prototype_reduced_motion_v1" in
        PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(input.toByteArray())),
    )
    assertTrue(
      PrototypeSpecValidator.validate(input, supportedCapabilities = emptySet())
        is PrototypeSpecValidation.Failure,
    )
    assertTrue(
      PrototypeSpecValidator.validate(
        input,
        supportedCapabilities = PrototypeStrictPolicy.required(spec),
      ) is PrototypeSpecValidation.Success,
    )
  }

  companion object {
    @BeforeAll @JvmStatic fun warmup() = PrototypeSpecFixtures.loadFixtures()
  }
}
