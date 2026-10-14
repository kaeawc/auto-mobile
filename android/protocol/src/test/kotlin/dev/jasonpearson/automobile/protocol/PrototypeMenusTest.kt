package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeMenusTest {
  companion object {
    private lateinit var valid: Map<String, String>
    private lateinit var invalid: Map<String, JsonObject>

    @JvmStatic
    @BeforeAll
    fun prepare() {
      val directory =
        generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec") }
          .first { it.isDirectory }
      valid =
        listOf("menu-overflow", "select-dropdown").associateWith {
          File(directory, "valid/$it.json").readText()
        }
      invalid =
        File(directory, "invalid")
          .listFiles()!!
          .filter { it.name.startsWith("menu-") || it.name.startsWith("select-") }
          .associate { it.name to Json.parseToJsonElement(it.readText()).jsonObject }
      // Load contract and serializer descriptors outside each test's timing budget.
      valid.values.forEach { PrototypeSpecValidator.validate(it) }
    }
  }

  @TestFactory
  fun `new valid fixtures decode and round trip`() =
    valid.map { (name, input) ->
      DynamicTest.dynamicTest(name) {
        val result = PrototypeSpecValidator.validate(input)
        assertTrue(result is PrototypeSpecValidation.Success, result.toString())
        val spec = (result as PrototypeSpecValidation.Success).spec
        val encoded = Json.encodeToString(PrototypeSpec.serializer(), spec)
        assertTrue(PrototypeSpecValidator.validate(encoded) is PrototypeSpecValidation.Success)
        if (name == "menu-overflow") {
          val menu = (spec.root as PrototypeRowNode).children[1] as PrototypeMenuNode
          assertEquals(PrototypeMenuDivider, menu.items[1])
          assertEquals(false, (menu.items[2] as PrototypeMenuEntry).enabled)
          assertFalse(encoded.contains("PrototypeMenuEntry"))
        } else assertTrue((spec.root as PrototypeColumnNode).children[0] is PrototypeSelectNode)
      }
    }

  @TestFactory
  fun `new invalid fixtures preserve canonical reasons`() =
    invalid.map { (name, fixture) ->
      DynamicTest.dynamicTest(name) {
        val result = PrototypeSpecValidator.validate(fixture.getValue("spec").toString())
        assertTrue(result is PrototypeSpecValidation.Failure, result.toString())
        val error = (result as PrototypeSpecValidation.Failure).error
        assertEquals(fixture.getValue("expectedPath").jsonPrimitive.content, error.path)
        assertEquals(fixture.getValue("expectedMessage").jsonPrimitive.content, error.message)
      }
    }

  @Test
  fun `select permits an unmatched string just like radio group`() {
    val spec =
      """{"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"choice":"other"},"root":{"type":"select","stateKey":"choice","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}}"""
    assertTrue(PrototypeSpecValidator.validate(spec) is PrototypeSpecValidation.Success)
  }

  @Test
  fun `repeat validates menu entry actions and select labels`() {
    val input =
      """{"id":"p","window":{"placement":{"type":"fullscreen"}},"state":{"open":false,"choice":"a"},"root":{"type":"column","repeat":{"as":"item","items":[{"key":"open","choice":"choice","label":"Bound"}]},"children":[{"type":"menu","openWhen":{"key":"{item.key}","equals":true},"items":[{"label":"{item.label}","trailingText":"{item.label}","onTap":[{"type":"setState","key":"{item.key}","value":false}]},{"type":"divider"}]},{"type":"select","stateKey":"{item.choice}","label":"{item.label}","options":[{"value":"a","label":"{item.label}"},{"value":"b","label":"B"}]}]}}"""
    assertTrue(PrototypeSpecValidator.validate(input) is PrototypeSpecValidation.Success)
    val rejected = PrototypeSpecValidator.validate(input.replace("{item.label}", "{item.missing}"))
    assertTrue(rejected is PrototypeSpecValidation.Failure, rejected.toString())
  }
}
