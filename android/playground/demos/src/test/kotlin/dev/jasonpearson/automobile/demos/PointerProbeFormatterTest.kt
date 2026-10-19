package dev.jasonpearson.automobile.demos

import org.junit.Assert.assertEquals
import org.junit.Test

class PointerProbeFormatterTest {
  @Test
  fun actionNamesCoverTouchAndHover() {
    assertEquals("DOWN", PointerProbeFormatter.actionName(0))
    assertEquals("UP", PointerProbeFormatter.actionName(1))
    assertEquals("MOVE", PointerProbeFormatter.actionName(2))
    assertEquals("HOVER_MOVE", PointerProbeFormatter.actionName(7))
    assertEquals("HOVER_ENTER", PointerProbeFormatter.actionName(9))
    assertEquals("HOVER_EXIT", PointerProbeFormatter.actionName(10))
    assertEquals("ACTION_99", PointerProbeFormatter.actionName(99))
  }

  @Test
  fun pointerActionsIncludeIndex() {
    // ACTION_POINTER_DOWN (5) for pointer index 1.
    assertEquals("POINTER_DOWN[1]", PointerProbeFormatter.actionName(5 or (1 shl 8)))
  }

  @Test
  fun toolTypeNames() {
    assertEquals("FINGER", PointerProbeFormatter.toolTypeName(1))
    assertEquals("STYLUS", PointerProbeFormatter.toolTypeName(2))
    assertEquals("MOUSE", PointerProbeFormatter.toolTypeName(3))
    assertEquals("ERASER", PointerProbeFormatter.toolTypeName(4))
    assertEquals("TOOL_42", PointerProbeFormatter.toolTypeName(42))
  }

  @Test
  fun sourceNamesListMatchingBits() {
    assertEquals("TOUCHSCREEN", PointerProbeFormatter.sourceNames(0x1002))
    assertEquals("STYLUS", PointerProbeFormatter.sourceNames(0x4002))
    assertEquals("STYLUS|TOUCHSCREEN", PointerProbeFormatter.sourceNames(0x1002 or 0x4002))
    assertEquals("STYLUS|BLUETOOTH_STYLUS", PointerProbeFormatter.sourceNames(0xC002))
    assertEquals("0x0", PointerProbeFormatter.sourceNames(0))
  }

  @Test
  fun buttonNamesListHeldButtons() {
    assertEquals("NONE", PointerProbeFormatter.buttonNames(0))
    assertEquals("PRIMARY|STYLUS_PRIMARY", PointerProbeFormatter.buttonNames(1 or 32))
  }

  @Test
  fun numbersUseTwoDecimals() {
    assertEquals("0.50", PointerProbeFormatter.number(0.5f))
    assertEquals("1.00", PointerProbeFormatter.number(1f))
    assertEquals("0.00", PointerProbeFormatter.number(0f))
  }

  @Test
  fun formatsStylusHoverEvent() {
    val event =
      ProbeEvent(
        via = "hover",
        action = 7,
        deviceId = 5,
        source = 0x4002,
        buttonState = 0,
        pointers =
          listOf(
            ProbePointer(
              id = 0,
              toolType = 2,
              pressure = 0f,
              tilt = 0.25f,
              orientation = 1.5f,
              x = 10f,
              y = 20.5f,
            ),
          ),
      )
    assertEquals(
      "#3 hover HOVER_MOVE dev=5 src=STYLUS(0x4002) btn=NONE(0) " +
        "p0:STYLUS pr=0.00 tilt=0.25 ori=1.50 xy=10.00,20.50",
      PointerProbeFormatter.format(3, event),
    )
  }

  @Test
  fun formatsTheButtonABarrelReleaseChanged() {
    val event =
      ProbeEvent(
        via = "generic",
        action = 12,
        deviceId = 5,
        source = 0x4002,
        buttonState = 0,
        pointers = emptyList(),
        actionButton = 32,
      )
    assertEquals(
      "#4 generic BUTTON_RELEASE dev=5 src=STYLUS(0x4002) btn=NONE(0) changed=STYLUS_PRIMARY ",
      PointerProbeFormatter.format(4, event),
    )
  }
}
