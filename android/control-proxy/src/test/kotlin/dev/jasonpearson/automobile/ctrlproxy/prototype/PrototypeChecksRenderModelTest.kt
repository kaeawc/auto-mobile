package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeButtonNode
import dev.jasonpearson.automobile.protocol.PrototypeCheck
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeCondition
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeRepeat
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeTextFieldNode
import dev.jasonpearson.automobile.protocol.PrototypeTimePickerNode
import dev.jasonpearson.automobile.protocol.PrototypeValidityKeys
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PrototypeChecksRenderModelTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmMapping() {
      val field =
        PrototypeTextFieldNode(
          stateKey = "warm",
          checks = listOf(PrototypeCheck.Required("Required")),
        )
      mapPrototypeSpec(
        PrototypeSpec(
          "warm",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          mapOf("warm" to PrototypeScalar.Text("")),
          field,
        ),
        shownErrors = setOf("warm"),
      )
    }
  }

  @Test
  fun `shared key must pass all nodes and hidden errors still disable button`() {
    val fields =
      listOf(
        PrototypeTextFieldNode(
          stateKey = "email",
          checks = listOf(PrototypeCheck.Required("Required")),
        ),
        PrototypeTextFieldNode(
          stateKey = "email",
          checks = listOf(PrototypeCheck.MinLength(4.0, "Too short")),
        ),
      )
    val condition = PrototypeCondition(valid = PrototypeValidityKeys.Single("email"))
    val spec =
      PrototypeSpec(
        "form",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("email" to PrototypeScalar.Text("a")),
        PrototypeColumnNode(
          children = fields + PrototypeButtonNode(label = "Send", enabledWhen = condition),
        ),
      )
    val mapper = PrototypeRenderMapper()
    val hidden = mapper.map(spec, emptyMap())
    assertFalse(hidden.root.children.last().enabled)
    assertNull(hidden.root.children[1].errorMessage)
    val shown = mapper.map(spec, emptyMap(), setOf("email"))
    assertNull(shown.root.children[0].errorMessage)
    assertEquals("Too short", shown.root.children[1].errorMessage)
    val valid =
      mapper.map(
        spec.copy(state = mapOf("email" to PrototypeScalar.Text("abcd"))),
        emptyMap(),
        setOf("email"),
      )
    assertTrue(valid.root.children.last().enabled)
    assertNull(valid.root.children[1].errorMessage)
  }

  @Test
  fun `time picker evaluates and shows hour and minute independently`() {
    val node =
      PrototypeTimePickerNode(
        hourKey = "hour",
        minuteKey = "minute",
        checks = listOf(PrototypeCheck.Min(10.0, "At least ten")),
      )
    val state =
      mapOf("hour" to PrototypeScalar.Numeric(12.0), "minute" to PrototypeScalar.Numeric(5.0))
    assertEquals(mapOf("hour" to true, "minute" to false), prototypeValidity(listOf(node), state))
    assertNull(prototypeShownError(node, state, setOf("hour")))
    assertEquals("At least ten", prototypeShownError(node, state, setOf("minute")))
    val validity = prototypeValidity(listOf(node), state)
    assertTrue(
      PrototypeCondition(
          not =
            PrototypeCondition(valid = PrototypeValidityKeys.Multiple(listOf("hour", "minute"))),
        )
        .holds(state, validity),
    )
  }

  @Test
  fun `repeat binds enabled condition validity keys and preserves checks`() {
    val node =
      PrototypeColumnNode(
        repeat =
          PrototypeRepeat(
            items = listOf(mapOf("id" to PrototypeScalar.Text("one"))),
            `as` = "item",
          ),
        children =
          listOf(
            PrototypeTextFieldNode(
              stateKey = "value_{item.id}",
              checks = listOf(PrototypeCheck.Required("Required")),
              enabledWhen =
                PrototypeCondition(valid = PrototypeValidityKeys.Single("value_{item.id}")),
            ),
          ),
      )
    val spec =
      PrototypeSpec(
        "repeat",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        mapOf("value_one" to PrototypeScalar.Text("")),
        node,
      )
    val field = mapPrototypeSpec(spec, shownErrors = setOf("value_one")).root.children.single()
    assertFalse(field.enabled)
    assertEquals("Required", field.errorMessage)
    assertEquals(listOf("value_one"), field.source?.checkedKeys())
  }
}
