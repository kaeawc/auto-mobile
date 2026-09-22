package dev.jasonpearson.automobile.ctrlproxy.ime.keyboard

import org.junit.Assert.assertEquals
import org.junit.Test

class KeyRepeatScheduleTest {
  @Test
  fun `fires immediately then repeats after delay`() {
    val schedule = KeyRepeatSchedule()

    assertEquals(1, schedule.firesAt(0))
    assertEquals(1, schedule.firesAt(399))
    assertEquals(2, schedule.firesAt(400))
    assertEquals(3, schedule.firesAt(450))
  }
}
