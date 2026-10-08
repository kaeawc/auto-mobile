package dev.jasonpearson.automobile.ctrlproxy.overlay

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class OverlayStateLogicTest {
  private val state =
    mapOf(
      "on" to OverlayScalar.BooleanValue(true),
      "count" to OverlayScalar.Numeric(3.0),
      "name" to OverlayScalar.Text("a"),
    )

  private fun eq(key: String, value: OverlayScalar) = OverlayCondition(key, equals = value)

  @Test
  fun `comparisons use exact scalar equality and numeric ordering`() {
    assertTrue(eq("on", OverlayScalar.BooleanValue(true)).holds(state))
    assertFalse(eq("on", OverlayScalar.Text("true")).holds(state))
    assertFalse(eq("missing", OverlayScalar.Numeric(0.0)).holds(state))
    assertTrue(OverlayCondition("name", notEquals = OverlayScalar.Text("b")).holds(state))
    assertTrue(OverlayCondition("missing", notEquals = OverlayScalar.Text("b")).holds(state))
    assertFalse(OverlayCondition("name", notEquals = OverlayScalar.Text("a")).holds(state))
    assertTrue(OverlayCondition("count", gt = 2.0).holds(state))
    assertFalse(OverlayCondition("count", gt = 3.0).holds(state))
    assertTrue(OverlayCondition("count", lt = 3.5).holds(state))
    assertFalse(OverlayCondition("name", lt = 100.0).holds(state))
    assertFalse(OverlayCondition("missing", gt = -1.0).holds(state))
  }

  @Test
  fun `all any and not compose and nest`() {
    val yes = eq("on", OverlayScalar.BooleanValue(true))
    val no = eq("on", OverlayScalar.BooleanValue(false))
    assertTrue(OverlayCondition(all = listOf(yes, OverlayCondition(not = no))).holds(state))
    assertFalse(OverlayCondition(all = listOf(yes, no)).holds(state))
    assertTrue(OverlayCondition(any = listOf(no, yes)).holds(state))
    assertFalse(OverlayCondition(any = listOf(no, no)).holds(state))
    assertFalse(OverlayCondition(not = OverlayCondition(any = listOf(no, yes))).holds(state))
    assertFalse(OverlayCondition().holds(state))
  }

  @Test
  fun `increment defaults to one and refuses non finite results`() {
    assertEquals(OverlayScalar.Numeric(4.0), OverlayIncrementAction("count").nextValue(state))
    assertEquals(
      OverlayScalar.Numeric(1.0),
      OverlayIncrementAction("count", by = -2.0).nextValue(state),
    )
    assertNull(OverlayIncrementAction("name").nextValue(state))
    assertNull(
      OverlayIncrementAction("count", by = Double.MAX_VALUE)
        .nextValue(mapOf("count" to OverlayScalar.Numeric(Double.MAX_VALUE)))
    )
  }

  @Test
  fun `toggle flips booleans only`() {
    assertEquals(OverlayScalar.BooleanValue(false), OverlayToggleAction("on").nextValue(state))
    assertNull(OverlayToggleAction("count").nextValue(state))
    assertNull(OverlayToggleAction("missing").nextValue(state))
  }
}
