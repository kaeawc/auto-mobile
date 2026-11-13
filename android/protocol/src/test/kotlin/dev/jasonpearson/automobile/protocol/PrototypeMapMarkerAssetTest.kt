package dev.jasonpearson.automobile.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

/** A marker `icon` that names an image asset (#16491) is carried by the bundle export. */
class PrototypeMapMarkerAssetTest {
  private fun images(name: String): Set<String> =
    PrototypeBundleSpec.references(fixtureDirectory().resolve("valid/$name").readBytes()).images

  @Test
  fun `the bundle lists a marker icon asset`() {
    assertEquals(setOf("car-pin"), images("map-marker-asset-icon.json"))
  }

  @Test
  fun `a Material marker icon name is not an asset`() {
    assertEquals(emptySet<String>(), images("map-node.json"))
  }
}
