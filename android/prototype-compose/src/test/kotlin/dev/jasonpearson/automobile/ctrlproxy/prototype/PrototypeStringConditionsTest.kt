package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeStringConditionsTest {
  @Test
  fun `shared conditions use UTF16 string semantics`() {
    val fixture =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-spec/conditions/string-conditions.json") }
        .first { it.isFile }
    for (entry in Json.parseToJsonElement(fixture.readText()).jsonArray) {
      val fields = entry.jsonObject
      val condition = Json.decodeFromJsonElement<PrototypeCondition>(fields.getValue("condition"))
      val state = Json.decodeFromJsonElement<Map<String, PrototypeScalar>>(fields.getValue("state"))
      assertEquals(
        fields.getValue("name").jsonPrimitive.content,
        fields.getValue("expected").jsonPrimitive.boolean,
        condition.holds(state),
      )
    }
  }

  @Test
  fun `forced error precedence and styling are independent of checks visibility`() {
    val state = mapOf("value" to PrototypeScalar.Text("hello"))
    val field =
      PrototypeTextFieldNode(
        stateKey = "value",
        errorWhen = PrototypeCondition(key = "value", contains = PrototypeScalar.Text("h")),
      )
    assertTrue(prototypeIsError(field, state, emptySet()))
    assertNull(prototypeShownError(field, state, emptySet()))
    assertEquals("Help", prototypeShownError(field.copy(supportingText = "Help"), state, emptySet()))
    assertEquals(
      "Error",
      prototypeShownError(field.copy(errorText = "Error", supportingText = "Help"), state, emptySet()),
    )
    val checked =
      field.copy(
        checks = listOf(PrototypeCheck.MinLength(10.0, "Too short")),
        supportingText = "Help",
      )
    assertEquals("Help", prototypeShownError(checked, state, emptySet()))
    assertEquals("Too short", prototypeShownError(checked, state, setOf("value")))
    assertEquals("Error", prototypeShownError(checked.copy(errorText = "Error"), state, setOf("value")))
    val normal =
      field.copy(
        errorWhen = PrototypeCondition(key = "value", startsWith = PrototypeScalar.Text("z")),
      )
    assertFalse(prototypeIsError(normal, state, emptySet()))
    assertTrue(checkedPrototypeNodes(field).isEmpty())
    assertTrue(PrototypeCondition(key = "value", contains = PrototypeScalar.Text("")).holds(state))
    assertTrue(PrototypeCondition(key = "value", startsWith = PrototypeScalar.Text("")).holds(state))
    assertFalse(PrototypeCondition(key = "value", contains = PrototypeScalar.Numeric(1.0)).holds(state))
  }
}
