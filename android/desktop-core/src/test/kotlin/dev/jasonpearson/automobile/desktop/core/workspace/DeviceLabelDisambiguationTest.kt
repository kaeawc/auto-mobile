package dev.jasonpearson.automobile.desktop.core.workspace

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceLabelDisambiguationTest {
  private data class Item(val id: String, val name: String)

  @Test
  fun `duplicate names use the shortest distinguishing stable id suffix`() {
    val labels =
      disambiguateLabels(
        listOf(Item("sim-A", "iPhone"), Item("sim-B", "iPhone"), Item("pixel-1", "Pixel")),
        Item::id,
        Item::name,
      )
    assertEquals("iPhone (A)", labels["sim-A"])
    assertEquals("iPhone (B)", labels["sim-B"])
    assertEquals("Pixel", labels["pixel-1"])
  }
}
