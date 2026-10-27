package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

  @Test
  fun `integer spellings decode repeat counts`() {
    val result =
      PrototypeSpecValidator.validate(
        fixtureDirectory().resolve("valid/icon-effects-integer-spellings.json").readText(),
      ) as PrototypeSpecValidation.Success
    val children = (result.spec.root as PrototypeRowNode).children
    assertEquals(listOf(5, 10), children.map { (it as PrototypeIconNode).effect?.repeat?.count })
    for (spelling in listOf("5.0", "1e1")) {
      assertNotNull(Json.decodeFromString<PrototypeIconEffectRepeat>(spelling).count)
    }
  }

  @Test
  fun `expanded fixture reaches loop cap`() {
    val fixture =
      Json.parseToJsonElement(
          fixtureDirectory().resolve("invalid/icon-effect-expanded-loop-limit.json").readText(),
        )
        .jsonObject
    val result =
      PrototypeSpecValidator.validate(fixture.getValue("spec").toString())
        as PrototypeSpecValidation.Failure
    assertEquals(fixture.getValue("expectedPath").jsonPrimitive.content, result.error.path)
    assertEquals("Expanded animated effect limit exceeded", result.error.message)
  }

  companion object {
    @BeforeAll @JvmStatic fun warmup() = PrototypeSpecFixtures.loadFixtures()
  }
}
