package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.*
import org.junit.Test

class PrototypePlacementTest {
  private val window = PrototypeTargetRect(0f, 0f, 400f, 600f)

  private fun place(
    target: PrototypeTargetRect,
    caret: String = "auto",
    rtl: Boolean = false,
    bubble: PrototypeBubbleSize = PrototypeBubbleSize(100f, 80f),
  ) = placePrototypeBubble(target, bubble, window, PrototypeBubbleOptions(rtl, caret, 8f, 8f, 12f))

  @Test
  fun belowFits() {
    val p = place(PrototypeTargetRect(100f, 100f, 140f, 140f))
    assertEquals("top", p.caret)
    assertEquals(148f, p.y)
    assertEquals(70f, p.x)
    assertEquals(50f, p.caretOffset)
  }

  @Test
  fun flipsAbove() {
    val p = place(PrototypeTargetRect(100f, 540f, 140f, 580f))
    assertEquals("bottom", p.caret)
    assertEquals(452f, p.y)
  }

  @Test
  fun explicitAboveFlipsBelow() {
    assertEquals("top", place(PrototypeTargetRect(100f, 10f, 140f, 50f), "bottom").caret)
  }

  @Test
  fun startSideFlipsToEnd() {
    assertEquals("end", place(PrototypeTargetRect(350f, 200f, 390f, 240f), "start").caret)
  }

  @Test
  fun rtlMirrorsLogicalEdges() {
    val target = PrototypeTargetRect(180f, 200f, 220f, 240f)
    assertEquals(228f, place(target, "start").x)
    assertEquals(72f, place(target, "start", rtl = true).x)
  }

  @Test
  fun clampKeepsCaretPointedAtTarget() {
    val p = place(PrototypeTargetRect(0f, 100f, 10f, 140f))
    assertEquals(8f, p.x)
    assertEquals(12f, p.caretOffset)
  }

  @Test
  fun neitherFitsChoosesMoreRoomAndClamps() {
    val p =
      place(PrototypeTargetRect(100f, 400f, 140f, 440f), bubble = PrototypeBubbleSize(390f, 590f))
    assertEquals("bottom", p.caret)
    assertEquals(8f, p.x)
    assertEquals(8f, p.y)
  }

  @Test
  fun autoUsesHorizontalRoomWhenVerticalDoesNotFit() {
    val p =
      place(PrototypeTargetRect(20f, 200f, 40f, 400f), bubble = PrototypeBubbleSize(100f, 300f))
    assertEquals("start", p.caret)
  }

  @Test
  fun menuFlipsWithZeroGapAndMargin() {
    val p =
      placePrototypeBubble(
        PrototypeTargetRect(200f, 500f, 300f, 550f),
        PrototypeBubbleSize(100f, 120f),
        window,
        PrototypeBubbleOptions(false, "top", 0f, 0f, 0f),
      )
    assertEquals("bottom", p.caret)
    assertEquals(380f, p.y)
  }
}
