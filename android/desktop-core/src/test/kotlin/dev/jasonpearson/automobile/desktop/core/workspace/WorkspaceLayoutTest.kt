package dev.jasonpearson.automobile.desktop.core.workspace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WorkspaceLayoutTest {

  @Test
  fun `facet grows when the stream is shrunk`() {
    assertTrue(facetHeightFraction(shrunk = true) > facetHeightFraction(shrunk = false))
  }

  @Test
  fun `facet fractions are valid split weights`() {
    for (shrunk in listOf(true, false)) {
      val fraction = facetHeightFraction(shrunk)
      assertTrue("fraction must be in (0,1) but was $fraction", fraction > 0f && fraction < 1f)
    }
  }

  @Test
  fun `first pane uses the shrink default until the user resizes it`() {
    val column = DeviceColumn(deviceId = "d", name = "Pixel", platform = Platform.Android)
    assertEquals(0.65f, firstPaneFraction(column), 0.0001f)
    assertEquals(0.2f, firstPaneFraction(column.copy(shrunk = true)), 0.0001f)
    assertEquals(0.5f, firstPaneFraction(column.copy(firstPaneFractionOverride = 0.5f)), 0.0001f)
  }
}
