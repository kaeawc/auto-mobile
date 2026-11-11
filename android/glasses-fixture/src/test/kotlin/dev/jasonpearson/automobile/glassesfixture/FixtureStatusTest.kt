package dev.jasonpearson.automobile.glassesfixture

import org.junit.Assert.assertEquals
import org.junit.Test

class FixtureStatusTest {
  @Test
  fun formatsFocusAndClickStatus() {
    assertEquals("focus: Item 3", FixtureStatus.focus("Item 3"))
    assertEquals("clicks: 0 last: none", FixtureStatus.click(0, null, null))
    assertEquals(
      "clicks: 2 last: Item 3 long: Item 2",
      FixtureStatus.click(2, "Item 3", "Item 2"),
    )
  }

  @Test
  fun formatsRawInputStatus() {
    assertEquals("key DPAD_CENTER ACTION_DOWN", FixtureStatus.key("DPAD_CENTER", "ACTION_DOWN"))
    assertEquals("motion 0x1002 MOVE", FixtureStatus.motion(0x1002, "MOVE"))
  }
}
