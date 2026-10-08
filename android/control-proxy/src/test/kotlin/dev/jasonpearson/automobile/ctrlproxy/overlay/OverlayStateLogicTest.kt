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
        .nextValue(mapOf("count" to OverlayScalar.Numeric(Double.MAX_VALUE))),
    )
  }

  @Test
  fun `decrement subtracts by defaulting to one and refuses non finite results`() {
    assertEquals(OverlayScalar.Numeric(2.0), OverlayDecrementAction("count").nextValue(state))
    assertEquals(
      OverlayScalar.Numeric(5.0),
      OverlayDecrementAction("count", by = -2.0).nextValue(state),
    )
    assertNull(OverlayDecrementAction("name").nextValue(state))
    assertNull(OverlayDecrementAction("missing").nextValue(state))
    assertNull(
      OverlayDecrementAction("count", by = Double.MAX_VALUE)
        .nextValue(mapOf("count" to OverlayScalar.Numeric(-Double.MAX_VALUE))),
    )
  }

  @Test
  fun `toggle flips booleans only`() {
    assertEquals(OverlayScalar.BooleanValue(false), OverlayToggleAction("on").nextValue(state))
    assertNull(OverlayToggleAction("count").nextValue(state))
    assertNull(OverlayToggleAction("missing").nextValue(state))
  }

  @Test
  fun `styleWhen merges matching entries over the base in authored order`() {
    val base =
      OverlayStyle(background = "#111111", alpha = 1.0, cornerRadius = OverlayCornerRadius.Dp(4.0))
    val entries =
      listOf(
        OverlayStyleWhen(eq("on", OverlayScalar.BooleanValue(true)), OverlayStyle(alpha = 0.5)),
        OverlayStyleWhen(eq("on", OverlayScalar.BooleanValue(false)), OverlayStyle(alpha = 0.1)),
        OverlayStyleWhen(
          OverlayCondition("count", gt = 2.0),
          OverlayStyle(alpha = 0.7, background = "#222222"),
        ),
      )
    val resolved = resolveOverlayStyle(base, entries, state)
    assertEquals(0.7, resolved.alpha!!, 0.0)
    assertEquals("#222222", resolved.background)
    assertEquals(OverlayCornerRadius.Dp(4.0), resolved.cornerRadius)
    val gradient =
      OverlayRadialGradient(listOf(OverlayGradientStop("#000000"), OverlayGradientStop("#ffffff")))
    val kept =
      resolveOverlayStyle(
        OverlayStyle(elevation = 4.0, gradient = gradient, aspectRatio = 2.0),
        listOf(
          OverlayStyleWhen(eq("on", OverlayScalar.BooleanValue(true)), OverlayStyle(alpha = 0.5)),
        ),
        state,
      )
    assertEquals(4.0, kept.elevation!!, 0.0)
    assertEquals(gradient, kept.gradient)
    assertEquals(2.0, kept.aspectRatio!!, 0.0)
    val overridden =
      resolveOverlayStyle(
        OverlayStyle(elevation = 4.0),
        listOf(
          OverlayStyleWhen(
            eq("on", OverlayScalar.BooleanValue(true)),
            OverlayStyle(elevation = 8.0, aspectRatio = 1.0),
          ),
        ),
        state,
      )
    assertEquals(8.0, overridden.elevation!!, 0.0)
    assertEquals(1.0, overridden.aspectRatio!!, 0.0)
    assertEquals(base, resolveOverlayStyle(base, null, state))
    assertEquals(OverlayStyle(), resolveOverlayStyle(null, entries.subList(1, 2), state))
  }

  @Test
  fun `styleWhen carries every style property, so no field is silently dropped by the merge`() {
    val full =
      OverlayStyle(
        width = OverlayDimension.Fill,
        height = OverlayDimension.Dp(40.0),
        weight = 2.0,
        minWidth = 1.0,
        maxWidth = 300.0,
        minHeight = 2.0,
        maxHeight = 200.0,
        padding = OverlayPadding(1.0, 2.0, 3.0, 4.0),
        background = "#112233",
        cornerRadius = OverlayCornerRadius.Corners(topStart = 8.0),
        border = OverlayBorder(1.0, "primary"),
        elevation = 6.0,
        shadowColor = "#80FF0000",
        gradient =
          OverlayRadialGradient(
            listOf(OverlayGradientStop("#000000"), OverlayGradientStop("#ffffff")),
          ),
        aspectRatio = 1.5,
        offset = OverlayOffset(2.0, -3.0),
        alpha = 0.5,
        alignment = "center",
        arrangement = "spaceBetween",
        spacing = 4.0,
        textSize = 18.0,
        fontWeight = 700,
        color = "onSurface",
        textAlign = "center",
        maxLines = 2,
        lineHeight = 24.0,
        letterSpacing = -0.5,
        textDecoration = "underline",
        fontStyle = "italic",
        overflow = "ellipsis",
        fontFamily = OverlayFontFamily.Named("serif"),
        textStyle = "titleLarge",
      )
    val on = eq("on", OverlayScalar.BooleanValue(true))
    assertEquals(full, resolveOverlayStyle(null, listOf(OverlayStyleWhen(on, full)), state))
    assertEquals(
      full,
      resolveOverlayStyle(full, listOf(OverlayStyleWhen(on, OverlayStyle())), state),
    )
  }
}
