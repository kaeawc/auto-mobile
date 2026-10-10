package dev.jasonpearson.automobile.ctrlproxy.prototype.hunt

import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeEventSink
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeInteraction
import dev.jasonpearson.automobile.ctrlproxy.prototype.PrototypeRuntime
import dev.jasonpearson.automobile.ctrlproxy.prototype.holds
import dev.jasonpearson.automobile.ctrlproxy.prototype.interpolatePrototypeText
import dev.jasonpearson.automobile.protocol.PrototypeColumnNode
import dev.jasonpearson.automobile.protocol.PrototypeCondition
import dev.jasonpearson.automobile.protocol.PrototypeEvent
import dev.jasonpearson.automobile.protocol.PrototypeFullscreenPlacement
import dev.jasonpearson.automobile.protocol.PrototypeScalar
import dev.jasonpearson.automobile.protocol.PrototypeSetStateAction
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeTextFieldNode
import dev.jasonpearson.automobile.protocol.PrototypeWindow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

class PrototypeRuntimeHuntTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  @Test
  fun `a tap whose later setState is rejected still reports the state it already changed`() =
    runTest {
      val events = mutableListOf<PrototypeEvent>()
      var sequence = 0L
      val spec =
        PrototypeSpec(
          "panel",
          PrototypeWindow(PrototypeFullscreenPlacement()),
          mapOf("flag" to PrototypeScalar.BooleanValue(false), "query" to PrototypeScalar.Text("")),
          PrototypeColumnNode(children = listOf(PrototypeTextFieldNode(stateKey = "query"))),
        )
      val runtime =
        PrototypeRuntime(spec, PrototypeEventSink { events += it }, { 1L }, { ++sequence })
      // The second action breaks the textField binding (a number in a string key); the spec
      // validator accepts the action itself, only the runtime rejects it.
      try {
        runtime.handle(
          PrototypeInteraction.Tap(
            listOf(
              PrototypeSetStateAction("flag", PrototypeScalar.BooleanValue(true)),
              PrototypeSetStateAction("query", PrototypeScalar.Numeric(1.0)),
            ),
          ),
        )
      } catch (expected: IllegalArgumentException) {
        // The controller logs and swallows this.
      }
      assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["flag"])
      // The host mirrors state through events; a mutation without a change event leaves it stale.
      assertTrue(
        "state changed to flag=true but no change event was emitted: $events",
        events.any { it.state["flag"] == PrototypeScalar.BooleanValue(true) },
      )
    }

  @Test
  fun `large numeric state interpolates without scientific notation like repeat bindings do`() {
    val state = mapOf("views" to PrototypeScalar.Numeric(12_345_678.0))
    assertEquals("12345678", interpolatePrototypeText("{views}", state))
  }

  @Test
  fun `negative zero interpolates as zero`() {
    assertEquals("0", interpolatePrototypeText("{n}", mapOf("n" to PrototypeScalar.Numeric(-0.0))))
  }

  @Test
  fun `a condition comparing to zero holds for negative zero state`() {
    val condition = PrototypeCondition(key = "n", equals = PrototypeScalar.Numeric(0.0))
    assertTrue(condition.holds(mapOf("n" to PrototypeScalar.Numeric(-0.0))))
  }
}
