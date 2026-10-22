package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

class PrototypeContractPatternsTest {
  companion object {
    @BeforeAll
    @JvmStatic
    fun loadContract() {
      check(PrototypeSpecContract.patterns.isNotEmpty())
    }
  }

  private val fixtures =
    Json.parseToJsonElement(File(fixtureDirectory(), "patterns.json").readText()).jsonObject

  @Test
  fun `corpus covers every contract pattern`() {
    assertEquals(PrototypeSpecContract.patterns.keys, fixtures.keys)
  }

  @TestFactory
  fun patternVerdicts(): List<DynamicTest> = fixtures.flatMap { (name, cases) ->
    cases.jsonObject.flatMap { (verdict, values) ->
      values.jsonArray.map { value ->
        DynamicTest.dynamicTest("$name $verdict $value") {
          val text = value.jsonPrimitive.content
          val accepted = verdict == "accepted"
          assertEquals(accepted, PrototypeSpecContract.patterns.getValue(name).matches(text))
          when (name) {
            "stateKey" -> assertEquals(accepted, PrototypeRepeatTemplate.isFieldName(text))
            "boundKey" -> assertEquals(accepted, PrototypeRepeatTemplate.isBoundKey(text))
            "pointer" -> assertEquals(accepted, PrototypeDataPointer.isValid(text))
          }
        }
      }
    }
  }
}
