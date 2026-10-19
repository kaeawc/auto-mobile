package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.*
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class PrototypeDataSubstitutionBudgetTest : PrototypeDataTestSupport() {
  @Test
  fun `condition operands share the exact substituted text total`() {
    val operand = buildJsonObject {
      put("key", "k")
      put("equals", "{item.b}y")
    }
    val condition = buildJsonObject {
      put(
        "all",
        JsonArray(List(16) { buildJsonObject { put("any", JsonArray(List(16) { operand })) } }),
      )
    }
    val child = JsonObject(substitutionText("t") + ("visibleWhen" to condition))
    val root = substitutionList(child, listOf("x".repeat(16375)))
    val state = buildJsonObject { put("k", "") }
    assertSubstitutionValid(substitutionSpec(root, state = state))
    val extra = JsonObject(substitutionText("t") + ("visibleWhen" to operand))
    val crossed = JsonObject(root + ("children" to JsonArray(listOf(child, extra))))
    val unknown = substitutionText("{item.missing}{data:/s}")
    val unknownRoot = JsonObject(root + ("children" to JsonArray(listOf(child, unknown))))
    assertEquals(
      PrototypeSpecError("root.children[1].text", "Unknown repeat field \"missing\""),
      PrototypeRepeatValidator.validate(
        substitutionSpec(unknownRoot, data = buildJsonObject { put("s", "") }, state = state),
      ),
    )
    assertEquals(
      PrototypeSpecError(
        "root.children[1].visibleWhen.equals",
        "Substituted text total limit exceeded",
      ),
      PrototypeRepeatValidator.validate(substitutionSpec(crossed, state = state)),
    )
  }

  @Test
  fun `data resolved text is charged per repeat item`() {
    val child = substitutionText("{data:/b}")
    val root = buildJsonObject {
      put("type", "column")
      put(
        "repeat",
        buildJsonObject {
          put("as", "i")
          put("items", JsonArray(List(128) { buildJsonObject {} }))
        },
      )
      put("children", JsonArray(listOf(child)))
    }
    val data = buildJsonObject { put("b", "x".repeat(16375)) }
    assertSubstitutionValid(substitutionSpec(root, data = data))
    val crossed = JsonObject(root + ("children" to JsonArray(listOf(child, child))))
    assertEquals(
      PrototypeSpecError("root.children[1].text", "Substituted text total limit exceeded"),
      PrototypeRepeatValidator.validate(substitutionSpec(crossed, data = data)),
    )
  }

  @Test
  fun `literal text inside a repeat is not charged`() {
    val child = substitutionText("x".repeat(16384))
    val root = buildJsonObject {
      put("type", "column")
      put(
        "repeat",
        buildJsonObject {
          put("as", "i")
          put("items", JsonArray(List(128) { buildJsonObject {} }))
        },
      )
      put("children", JsonArray(listOf(child, child)))
    }
    assertSubstitutionValid(substitutionSpec(root))
  }

  @Test
  fun `repeat total charges each item in order`() {
    val root = buildJsonObject {
      put("type", "column")
      put(
        "repeat",
        buildJsonObject {
          put("as", "i")
          put("items", JsonArray(List(4) { buildJsonObject { put("b", "x".repeat(16379)) } }))
        },
      )
      put("children", JsonArray(List(64) { substitutionText("{i.b}") }))
    }
    assertSubstitutionValid(substitutionSpec(root))
    val crossed =
      JsonObject(root + ("children" to JsonArray(List(65) { substitutionText("{i.b}") })))
    assertEquals(
      PrototypeSpecError("root.children[64].text", "Substituted text total limit exceeded"),
      PrototypeRepeatValidator.validate(substitutionSpec(crossed)),
    )
  }

  @Test
  fun `per field substitution error wins before the total charge`() {
    assertSubstitutionError(
      substitutionSpec(
        substitutionList(substitutionText("{item.b}{item.b}"), listOf("x".repeat(8193))),
      ),
      "root.children[0].text",
    )
  }
}
