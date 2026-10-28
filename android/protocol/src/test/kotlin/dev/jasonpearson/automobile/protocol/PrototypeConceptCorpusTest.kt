package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/** Reference concept slices (#14205), shared with the TypeScript and Swift suites. */
class PrototypeConceptCorpusTest {
  @Test
  fun `the corpus holds at least one concept`() {
    assertTrue(concepts.isNotEmpty())
  }

  @TestFactory
  fun conceptSlices(): List<DynamicTest> = concepts.flatMap { concept ->
    listOf(
      DynamicTest.dynamicTest("decode ${concept.name}") {
        val result = PrototypeSpecValidator.validate(concept.json)
        assertTrue(result is PrototypeSpecValidation.Success, result.toString())
        val spec = (result as PrototypeSpecValidation.Success).spec
        val encoded = Json.encodeToString(PrototypeSpec.serializer(), spec)
        assertTrue(PrototypeSpecValidator.validate(encoded) is PrototypeSpecValidation.Success)
      },
      DynamicTest.dynamicTest("capabilities ${concept.name}") {
        val spec = Json.parseToJsonElement(PrototypeStrictJson.prepare(concept.json)).jsonObject
        assertEquals(concept.capabilities, PrototypeStrictPolicy.required(spec), concept.name)
      },
    )
  }

  private class Concept(val name: String, val json: String, val capabilities: Set<String>)

  companion object {
    private lateinit var concepts: List<Concept>

    @BeforeAll
    @JvmStatic
    fun loadConcepts() {
      val directory = File(fixtureDirectory().parentFile, "prototype-concepts")
      concepts =
        directory
          .listFiles()
          .orEmpty()
          .filter { it.isDirectory }
          .sortedBy { it.name }
          .map { concept ->
            val manifest =
              Json.parseToJsonElement(File(concept, "concept.json").readText()).jsonObject
            Concept(
              concept.name,
              File(concept, "today.json").readText(),
              manifest.getValue("capabilities").jsonArray.map { it.jsonPrimitive.content }.toSet(),
            )
          }
      // Materialize the lazy serializers before JUnit starts measuring each test.
      for (concept in concepts) {
        val decoded = PrototypeSpecValidator.validate(concept.json)
        if (decoded is PrototypeSpecValidation.Success)
          Json.encodeToString(PrototypeSpec.serializer(), decoded.spec)
      }
    }
  }
}
