package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

class PrototypeChannelsTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warm() {
      val file = File(fixtureDirectory(), "valid/realtime-channels.json")
      PrototypeSpecValidator.validate(file.readText(), emptySet())
      PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(file.readBytes()))
    }
  }

  @TestFactory
  fun libraryReviewAcceptance(): List<DynamicTest> =
    listOf("realtime-review-boundaries", "realtime-review-legacy-bindings").map { name ->
      DynamicTest.dynamicTest("library accepts $name") {
        val file = File(fixtureDirectory(), "valid/$name.json")
        val required =
          PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(file.readBytes()))
            .toSet()
        assertTrue(
          PrototypeSpecValidator.validate(file.readText(), required, true)
            is PrototypeSpecValidation.Success,
        )
        if (name.endsWith("legacy-bindings"))
          assertFalse("prototype_platform_realtime_v1" in required)
      }
    }

  @TestFactory
  fun bundleRealtimeCapabilities(): List<DynamicTest> {
    val expected =
      Json.parseToJsonElement(File(fixtureDirectory(), "corpus.json").readText())
        .jsonObject
        .getValue("validCapabilities")
        .jsonObject
    return File(fixtureDirectory(), "valid")
      .listFiles()!!
      .filter { it.name.startsWith("realtime-") }
      .map { file ->
        DynamicTest.dynamicTest("bundle " + file.name) {
          val required =
            PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(file.readBytes()))
          assertEquals(
            expected.getValue(file.name).jsonArray.map { it.jsonPrimitive.content },
            required,
          )
        }
      }
  }

  @TestFactory
  fun sharedRealtimeErrors(): List<DynamicTest> =
    File(fixtureDirectory(), "invalid")
      .listFiles()!!
      .filter {
        it.name.startsWith("realtime-") ||
          it.name.startsWith("strict-gate-prototype_platform_realtime")
      }
      .map { file ->
        val fixture = Json.parseToJsonElement(file.readText()).jsonObject
        DynamicTest.dynamicTest(file.name) {
          val supported =
            (fixture["options"]?.jsonObject?.get("supportedCapabilities") as? JsonArray)
              ?.map { it.jsonPrimitive.content }
              ?.toSet()
          val result =
            PrototypeSpecValidator.validate(
              fixture.getValue("spec").toString(),
              supported,
              (fixture["options"]?.jsonObject?.get("library") as? JsonPrimitive)?.booleanOrNull
                ?: false,
            )
          assertTrue(result is PrototypeSpecValidation.Failure)
          val error = (result as PrototypeSpecValidation.Failure).error
          assertEquals(fixture.getValue("expectedPath").jsonPrimitive.content, error.path)
          assertEquals(fixture.getValue("expectedMessage").jsonPrimitive.content, error.message)
        }
      }
}
