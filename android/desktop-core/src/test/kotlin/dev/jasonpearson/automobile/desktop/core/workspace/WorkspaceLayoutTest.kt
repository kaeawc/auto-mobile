package dev.jasonpearson.automobile.desktop.core.workspace

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
}
