package dev.jasonpearson.automobile.protocol

import java.io.File
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PrototypeGlassTest {
  @Test
  fun `bundle namespace requirements match the spec corpus`() {
    val cases =
      mapOf(
        "glass-namespace-only" to listOf("prototype_glass_v1"),
        "glass-namespace-mixed" to listOf("prototype_glass_v1", "prototype_platform_namespace_v1"),
      )
    for ((name, expected) in cases) {
      val bytes = File(fixtureDirectory(), "valid/$name.json").readBytes()
      assertEquals(
        expected,
        PrototypeBundleCapabilities.required(PrototypeBundleSpec.references(bytes)),
        name,
      )
    }
  }
}
