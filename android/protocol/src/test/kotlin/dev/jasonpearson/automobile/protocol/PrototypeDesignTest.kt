package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeSpecFixtures.valid
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test

class PrototypeDesignTest {
  companion object {
    @BeforeAll @JvmStatic fun loadFixtures() = PrototypeSpecFixtures.loadFixtures()
  }

  @Test
  fun `typed theme accepts both designs from the shared corpus`() {
    for (design in listOf("platform", "material")) {
      val input =
        PrototypeSpecFixtures.validJson.getValue(valid.first { it.name == "design-$design.json" })
      val result = PrototypeSpecValidator.validate(input)
      assertTrue(result is PrototypeSpecValidation.Success)
      assertEquals(design, (result as PrototypeSpecValidation.Success).spec.theme?.design)
    }
    assertNull(PrototypeSpecTheme().design)
  }
}
