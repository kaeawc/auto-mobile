package dev.jasonpearson.automobile.protocol

import org.junit.Assert.assertEquals
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeMotionTokensTest {
  companion object {
    @BeforeAll
    @JvmStatic
    fun loadContract() {
      PrototypeMotionTokens.token()
    }
  }

  @Test
  fun propertiesSelectTheirPhysicalRole() {
    for (property in
      listOf(
        "offset",
        "scale",
        "rotation",
        "cornerRadius",
        "elevation",
        "shadowColor",
        "padding",
        "border.width",
        "width",
        "height",
      )) assertEquals("spatial", PrototypeMotionTokens.role(property))
    for (property in listOf("alpha", "background", "color", "border.color")) assertEquals(
      "effects",
      PrototypeMotionTokens.role(property),
    )
  }

  @Test
  fun tableMatchesTheContractPhysics() {
    val tempos = listOf("fast", "default", "slow")
    for ((scheme, ratios, stiffnesses) in
      listOf(
        Triple("standard", listOf(0.9, 0.9, 0.9), listOf(1400, 700, 300)),
        Triple("expressive", listOf(0.6, 0.8, 0.8), listOf(800, 380, 200)),
      )) {
      for ((index, tempo) in tempos.withIndex()) {
        assertEquals(
          PrototypeMotionToken(ratios[index], stiffnesses[index].toDouble()),
          PrototypeMotionTokens.token(scheme, "spatial", tempo),
        )
        assertEquals(
          PrototypeMotionToken(1.0, listOf(3800, 1600, 800)[index].toDouble()),
          PrototypeMotionTokens.token(scheme, "effects", tempo),
        )
      }
    }
  }
}
