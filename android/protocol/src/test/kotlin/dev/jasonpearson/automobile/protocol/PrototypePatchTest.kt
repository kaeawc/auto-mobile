package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypePatchTest {
  @TestFactory
  fun sharedFixtures(): List<DynamicTest> {
    assertTrue(fixtures.size >= 45, "Expected at least 45 shared patch fixtures")
    return fixtures.map { (file, fixture) ->
      DynamicTest.dynamicTest(file.name) { checkFixture(fixture) }
    }
  }

  private fun checkFixture(fixture: JsonObject) {
    val spec = fixture.getValue("spec")
    assertTrue(PrototypeSpecValidator.validate(spec.toString()) is PrototypeSpecValidation.Success)
    val tests =
      if (fixture["stateTests"]?.jsonPrimitive?.content == "skip") {
        PrototypePatch.StateTests.SKIP
      } else PrototypePatch.StateTests.EVALUATE
    val result = PrototypePatch.apply(spec, fixture.getValue("ops"), tests)
    when (fixture["stage"]?.jsonPrimitive?.content) {
      "apply" -> assertEquals(PrototypePatch.Result.Failure(expectedError(fixture)), result)
      "validate" -> {
        assertTrue(result is PrototypePatch.Result.Success, result.toString())
        val patched = (result as PrototypePatch.Result.Success).spec
        assertEquals(
          PrototypeSpecValidation.Failure(expectedError(fixture)),
          PrototypeSpecValidator.validate(patched.toString()),
        )
      }
      else -> {
        assertTrue(result is PrototypePatch.Result.Success, result.toString())
        val expected = fixture.getValue("expected").jsonObject
        assertEquals(expected, (result as PrototypePatch.Result.Success).spec)
        assertTrue(
          PrototypeSpecValidator.validate(expected.toString()) is PrototypeSpecValidation.Success,
        )
      }
    }
  }

  private fun expectedError(fixture: JsonObject): PrototypeSpecError =
    PrototypeSpecError(
      fixture.getValue("expectedPath").jsonPrimitive.content,
      fixture.getValue("expectedMessage").jsonPrimitive.content,
    )

  @Test
  fun `op count boundary and shared limit`() {
    assertEquals(64, PrototypeSpecValidator.MAX_PROTOTYPE_PATCH_OPS)
    val spec = JsonObject(mapOf("data" to JsonObject(emptyMap())))
    val op = Json.parseToJsonElement("""{"op":"test","path":"/data","value":{}}""")
    assertEquals(
      PrototypePatch.Result.Success(spec),
      PrototypePatch.apply(spec, JsonArray(List(64) { op })),
    )
    assertEquals(
      PrototypePatch.Result.Failure(PrototypeSpecError("ops", "Array length out of range")),
      PrototypePatch.apply(spec, JsonArray(List(65) { op })),
    )
  }

  @Test
  fun `state touch detection ignores unrelated and malformed paths`() {
    for (path in listOf("/state", "/state/a")) {
      assertTrue(
        PrototypePatch.touchesState(
          JsonArray(listOf(JsonObject(mapOf("path" to JsonPrimitive(path))))),
        ),
      )
    }
    for (path in listOf("/data/state", "/stateful")) {
      assertFalse(
        PrototypePatch.touchesState(
          JsonArray(listOf(JsonObject(mapOf("path" to JsonPrimitive(path))))),
        ),
      )
    }
    assertFalse(PrototypePatch.touchesState(JsonObject(emptyMap())))
    assertFalse(
      PrototypePatch.touchesState(Json.parseToJsonElement("""[null,1,{}, {"path":true}]""")),
    )
  }

  @Test
  fun `non object spec is refused first`() {
    assertEquals(
      PrototypePatch.Result.Failure(PrototypeSpecError("$", "Expected object")),
      PrototypePatch.apply(JsonNull, JsonNull),
    )
  }

  companion object {
    private lateinit var fixtures: Map<File, JsonObject>

    @BeforeAll
    @JvmStatic
    fun loadFixtures() {
      fixtures =
        File(fixtureDirectory(), "patch")
          .listFiles()
          .orEmpty()
          .filter { it.extension == "json" }
          .sortedBy { it.name }
          .associateWith { Json.parseToJsonElement(it.readText()).jsonObject }
      // Warm contract loading and validator discovery outside dynamic-test timing.
      fixtures.values.firstOrNull()?.let {
        PrototypeSpecValidator.validate(it.getValue("spec").toString())
      }
    }
  }
}
