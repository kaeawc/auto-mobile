package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/** R1 fixtures shared with the TypeScript validator: a library spec uses no sensitive module. */
class PrototypeLibraryModulesTest {
  private val files: List<File> =
    File(fixtureDirectory(), "library-modules")
      .listFiles { file -> file.extension == "json" }
      .orEmpty()
      .sortedBy { it.name }

  @Test
  fun `fixtures cover refused calls, a refused handler and accepted modules`() {
    assertEquals(3, files.count { it.name.startsWith("valid-") })
    assertEquals(4, files.count { !it.name.startsWith("valid-") })
  }

  @TestFactory
  fun libraryModuleFixtures(): List<DynamicTest> = files.map { file ->
    DynamicTest.dynamicTest(file.name) {
      val fixture = Json.parseToJsonElement(file.readText()).jsonObject
      val spec = fixture.getValue("spec").toString()
      assertEquals(
        JsonObject(mapOf("library" to JsonPrimitive(true))),
        fixture["options"],
      )
      val accepted = PrototypeSpecValidator.validate(spec, library = false)
      assertTrue(accepted is PrototypeSpecValidation.Success, accepted.toString())
      val result = PrototypeSpecValidator.validate(spec, library = true)
      val expectedPath = fixture["expectedPath"]?.jsonPrimitive?.content
      assertEquals(expectedPath == null, file.name.startsWith("valid-"))
      if (expectedPath == null) {
        assertTrue(result is PrototypeSpecValidation.Success, result.toString())
      } else {
        assertEquals(
          PrototypeSpecValidation.Failure(
            PrototypeSpecError(
              expectedPath,
              fixture.getValue("expectedMessage").jsonPrimitive.content,
            ),
          ),
          result,
        )
      }
    }
  }
}
