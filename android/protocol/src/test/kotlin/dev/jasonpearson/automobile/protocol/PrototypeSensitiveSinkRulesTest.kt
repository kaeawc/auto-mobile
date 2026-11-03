package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

class PrototypeSensitiveSinkRulesTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warm() {
      val fixture =
        Json.parseToJsonElement(
            File(fixtureDirectory(), "library-sensitive/storage-exact.json").readText(),
          )
          .jsonObject
      PrototypeSpecValidator.validate(fixture.getValue("spec").toString(), library = true)
    }
  }

  @TestFactory
  fun sharedSensitiveFixtures(): List<DynamicTest> =
    File(fixtureDirectory(), "library-sensitive")
      .listFiles()!!
      .filter { it.extension == "json" }
      .sortedBy { it.name }
      .map { file ->
        val fixture = Json.parseToJsonElement(file.readText()).jsonObject
        val spec = fixture.getValue("spec").toString()
        DynamicTest.dynamicTest(file.name) {
          assertTrue(PrototypeSpecValidator.validate(spec) is PrototypeSpecValidation.Success)
          val path = fixture["expectedPath"]?.jsonPrimitive?.content
          if (path != null) {
            assertEquals(
              PrototypeSpecValidation.Failure(
                PrototypeSpecError(path, fixture.getValue("expectedMessage").jsonPrimitive.content),
              ),
              PrototypeSpecValidator.validate(spec, library = true),
            )
          } else {
            assertTrue(
              PrototypeSpecValidator.validate(spec, library = true)
                is PrototypeSpecValidation.Success,
            )
          }
        }
      }
}
