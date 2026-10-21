package dev.jasonpearson.automobile.ctrlproxy.prototype

import org.junit.Assert.assertEquals
import org.junit.Test

class ShortcutIconGeometryTest {
  @Test
  fun `edge uses density and both launcher limits with a positive floor`() {
    assertEquals(108, ShortcutIconGeometry.sizePx(1f, 500, 500))
    assertEquals(80, ShortcutIconGeometry.sizePx(2f, 80, 200))
    assertEquals(60, ShortcutIconGeometry.sizePx(2f, 200, 60))
    assertEquals(1, ShortcutIconGeometry.sizePx(0f, 0, 0))
  }

  @Test
  fun `safe zone is centered and occupies seventy two of one hundred eight`() {
    assertEquals(18f to 90f, ShortcutIconGeometry.safeZone(108))
    assertEquals(9f to 45f, ShortcutIconGeometry.safeZone(54))
  }
}
