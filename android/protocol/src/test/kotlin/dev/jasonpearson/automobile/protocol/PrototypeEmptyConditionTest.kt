package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PrototypeEmptyConditionTest {
  private fun json(text: String) = Json.parseToJsonElement(text)

  @Test
  fun `missing, null and empty containers and strings are empty`() {
    val empty = listOf(null, JsonNull, json("[]"), json("{}"), json("\"\""))
    val filled = listOf(json("0"), json("false"), json("\" \""), json("[0]"), json("""{"a":1}"""))
    assertEquals(List(empty.size) { true }, empty.map(PrototypeDataValues::isEmpty))
    assertEquals(List(filled.size) { false }, filled.map(PrototypeDataValues::isEmpty))
  }

  @Test
  fun `empty false holds for a filled value and a non-boolean operand never holds`() {
    val data = json("""{"feed":[1]}""").jsonObject
    val holds = { condition: String ->
      PrototypeDataValues.holds(json(condition).jsonObject, data)
    }
    assertEquals(true, holds("""{"data":"/feed","empty":false}"""))
    assertEquals(false, holds("""{"data":"/feed","empty":true}"""))
    assertEquals(true, holds("""{"data":"/gone","empty":true}"""))
    assertEquals(false, holds("""{"data":"/gone","empty":"yes"}"""))
  }
}
