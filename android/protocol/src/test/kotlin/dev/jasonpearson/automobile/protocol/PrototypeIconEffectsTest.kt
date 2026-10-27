package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeIconEffectsTest {
  @Test
  fun `icon effects decode and round trip with both capability scanners`() {
    val input = fixtureDirectory().resolve("valid/icon-effects-repeat.json").readText()
    val result = PrototypeSpecValidator.validate(input)
    assertTrue(result is PrototypeSpecValidation.Success, result.toString())
    val spec = Json.parseToJsonElement(input).jsonObject
    assertTrue("prototype_icon_effects_v1" in PrototypeStrictPolicy.required(spec))
    assertTrue(
      "prototype_icon_effects_v1" in
        PrototypeBundleCapabilities.required(
          PrototypeBundleSpec.references(input.toByteArray()),
        ),
    )
    val encoded =
      Json.encodeToString(
        PrototypeSpec.serializer(),
        (result as PrototypeSpecValidation.Success).spec,
      )
    assertTrue(PrototypeSpecValidator.validate(encoded) is PrototypeSpecValidation.Success)
  }

  @Test
  fun `invalid shared icon effect fixtures are rejected`() {
    for (file in
      fixtureDirectory().resolve("invalid").listFiles().orEmpty().filter {
        it.name.startsWith("icon-effect-")
      }) {
      val fixture = Json.parseToJsonElement(file.readText()).jsonObject
      assertTrue(
        PrototypeSpecValidator.validate(fixture.getValue("spec").toString())
          is PrototypeSpecValidation.Failure,
        file.name,
      )
    }
  }

  companion object {
    @BeforeAll @JvmStatic fun warmup() = PrototypeSpecFixtures.loadFixtures()
  }
}
