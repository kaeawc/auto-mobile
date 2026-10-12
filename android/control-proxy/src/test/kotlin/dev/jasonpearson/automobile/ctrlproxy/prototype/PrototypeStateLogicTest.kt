package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import org.junit.Assert.*
import org.junit.Test

class PrototypeStateLogicTest {
  private val state =
    mapOf(
      "on" to PrototypeScalar.BooleanValue(true),
      "count" to PrototypeScalar.Numeric(3.0),
      "name" to PrototypeScalar.Text("a"),
    )

  private fun eq(key: String, value: PrototypeScalar) = PrototypeCondition(key, equals = value)

  @Test
  fun `comparisons use exact scalar equality and numeric ordering`() {
    assertTrue(eq("on", PrototypeScalar.BooleanValue(true)).holds(state))
    assertFalse(eq("on", PrototypeScalar.Text("true")).holds(state))
    assertFalse(eq("missing", PrototypeScalar.Numeric(0.0)).holds(state))
    assertTrue(PrototypeCondition("name", notEquals = PrototypeScalar.Text("b")).holds(state))
    assertTrue(PrototypeCondition("missing", notEquals = PrototypeScalar.Text("b")).holds(state))
    assertFalse(PrototypeCondition("name", notEquals = PrototypeScalar.Text("a")).holds(state))
    assertTrue(PrototypeCondition("count", gt = 2.0).holds(state))
    assertFalse(PrototypeCondition("count", gt = 3.0).holds(state))
    assertTrue(PrototypeCondition("count", lt = 3.5).holds(state))
    assertFalse(PrototypeCondition("name", lt = 100.0).holds(state))
    assertFalse(PrototypeCondition("missing", gt = -1.0).holds(state))
  }

  @Test
  fun `negative zero equals zero as it does on the host and on iOS`() {
    val negativeZero = mapOf("n" to PrototypeScalar.Numeric(-0.0))
    val zero = PrototypeScalar.Numeric(0.0)
    assertTrue(eq("n", zero).holds(negativeZero))
    assertFalse(PrototypeCondition("n", notEquals = zero).holds(negativeZero))
    assertTrue(eq("count", PrototypeScalar.Numeric(-0.0)).holds(state + ("count" to zero)))
    // Still strict about type: a number never equals its text.
    assertFalse(eq("n", PrototypeScalar.Text("0")).holds(negativeZero))
    assertTrue(PrototypeCondition("n", notEquals = PrototypeScalar.Text("0")).holds(negativeZero))
  }

  @Test
  fun `all any and not compose and nest`() {
    val yes = eq("on", PrototypeScalar.BooleanValue(true))
    val no = eq("on", PrototypeScalar.BooleanValue(false))
    assertTrue(PrototypeCondition(all = listOf(yes, PrototypeCondition(not = no))).holds(state))
    assertFalse(PrototypeCondition(all = listOf(yes, no)).holds(state))
    assertTrue(PrototypeCondition(any = listOf(no, yes)).holds(state))
    assertFalse(PrototypeCondition(any = listOf(no, no)).holds(state))
    assertFalse(PrototypeCondition(not = PrototypeCondition(any = listOf(no, yes))).holds(state))
    assertFalse(PrototypeCondition().holds(state))
  }

  @Test
  fun `increment defaults to one and refuses non finite results`() {
    assertEquals(PrototypeScalar.Numeric(4.0), PrototypeIncrementAction("count").nextValue(state))
    assertEquals(
      PrototypeScalar.Numeric(1.0),
      PrototypeIncrementAction("count", by = -2.0).nextValue(state),
    )
    assertNull(PrototypeIncrementAction("name").nextValue(state))
    assertNull(
      PrototypeIncrementAction("count", by = Double.MAX_VALUE)
        .nextValue(mapOf("count" to PrototypeScalar.Numeric(Double.MAX_VALUE))),
    )
  }

  @Test
  fun `decrement subtracts by defaulting to one and refuses non finite results`() {
    assertEquals(PrototypeScalar.Numeric(2.0), PrototypeDecrementAction("count").nextValue(state))
    assertEquals(
      PrototypeScalar.Numeric(5.0),
      PrototypeDecrementAction("count", by = -2.0).nextValue(state),
    )
    assertNull(PrototypeDecrementAction("name").nextValue(state))
    assertNull(PrototypeDecrementAction("missing").nextValue(state))
    assertNull(
      PrototypeDecrementAction("count", by = Double.MAX_VALUE)
        .nextValue(mapOf("count" to PrototypeScalar.Numeric(-Double.MAX_VALUE))),
    )
  }

  @Test
  fun `toggle flips booleans only`() {
    assertEquals(PrototypeScalar.BooleanValue(false), PrototypeToggleAction("on").nextValue(state))
    assertNull(PrototypeToggleAction("count").nextValue(state))
    assertNull(PrototypeToggleAction("missing").nextValue(state))
  }

  @Test
  fun `styleWhen merges matching entries over the base in authored order`() {
    val base =
      PrototypeStyle(
        background = PrototypeModeValue.Single("#111111"),
        alpha = 1.0,
        cornerRadius = PrototypeCornerRadius.Dp(4.0),
      )
    val entries =
      listOf(
        PrototypeStyleWhen(
          eq("on", PrototypeScalar.BooleanValue(true)),
          PrototypeStyle(alpha = 0.5),
        ),
        PrototypeStyleWhen(
          eq("on", PrototypeScalar.BooleanValue(false)),
          PrototypeStyle(alpha = 0.1),
        ),
        PrototypeStyleWhen(
          PrototypeCondition("count", gt = 2.0),
          PrototypeStyle(alpha = 0.7, background = PrototypeModeValue.Single("#222222")),
        ),
      )
    val resolved = resolvePrototypeStyle(base, entries, state)
    assertEquals(0.7, resolved.alpha!!, 0.0)
    assertEquals(PrototypeModeValue.Single("#222222"), resolved.background)
    assertEquals(PrototypeCornerRadius.Dp(4.0), resolved.cornerRadius)
    val gradient =
      PrototypeRadialGradient(
        listOf(PrototypeGradientStop("#000000"), PrototypeGradientStop("#ffffff")),
      )
    val kept =
      resolvePrototypeStyle(
        PrototypeStyle(elevation = 4.0, gradient = gradient, aspectRatio = 2.0),
        listOf(
          PrototypeStyleWhen(
            eq("on", PrototypeScalar.BooleanValue(true)),
            PrototypeStyle(alpha = 0.5),
          ),
        ),
        state,
      )
    assertEquals(4.0, kept.elevation!!, 0.0)
    assertEquals(gradient, kept.gradient)
    assertEquals(2.0, kept.aspectRatio!!, 0.0)
    val overridden =
      resolvePrototypeStyle(
        PrototypeStyle(elevation = 4.0),
        listOf(
          PrototypeStyleWhen(
            eq("on", PrototypeScalar.BooleanValue(true)),
            PrototypeStyle(elevation = 8.0, aspectRatio = 1.0),
          ),
        ),
        state,
      )
    assertEquals(8.0, overridden.elevation!!, 0.0)
    assertEquals(1.0, overridden.aspectRatio!!, 0.0)
    assertEquals(base, resolvePrototypeStyle(base, null, state))
    assertEquals(PrototypeStyle(), resolvePrototypeStyle(null, entries.subList(1, 2), state))
  }

  @Test
  fun `styleWhen carries every style property, so no field is silently dropped by the merge`() {
    val full =
      PrototypeStyle(
        width = PrototypeDimension.Fill,
        height = PrototypeDimension.Dp(40.0),
        weight = 2.0,
        minWidth = 1.0,
        maxWidth = 300.0,
        minHeight = 2.0,
        maxHeight = 200.0,
        padding = PrototypePadding(1.0, 2.0, 3.0, 4.0),
        background = PrototypeModeValue.Single("#112233"),
        cornerRadius = PrototypeCornerRadius.Corners(topStart = 8.0),
        border = PrototypeBorder(1.0, "primary"),
        elevation = 6.0,
        shadowColor = PrototypeModeValue.Single("#80FF0000"),
        gradient =
          PrototypeRadialGradient(
            listOf(PrototypeGradientStop("#000000"), PrototypeGradientStop("#ffffff")),
          ),
        aspectRatio = 1.5,
        offset = PrototypeOffset(2.0, -3.0),
        alpha = 0.5,
        pressScale = 0.9,
        alignment = "center",
        arrangement = "spaceBetween",
        spacing = 4.0,
        textSize = 18.0,
        fontWeight = 700,
        color = PrototypeModeValue.Single("onSurface"),
        textAlign = "center",
        maxLines = 2,
        lineHeight = 24.0,
        letterSpacing = -0.5,
        textDecoration = "underline",
        fontStyle = "italic",
        overflow = "ellipsis",
        fontFamily = PrototypeFontFamily.Named("serif"),
        textStyle = "titleLarge",
      )
    val on = eq("on", PrototypeScalar.BooleanValue(true))
    assertEquals(full, resolvePrototypeStyle(null, listOf(PrototypeStyleWhen(on, full)), state))
    assertEquals(
      full,
      resolvePrototypeStyle(full, listOf(PrototypeStyleWhen(on, PrototypeStyle())), state),
    )
  }
}
