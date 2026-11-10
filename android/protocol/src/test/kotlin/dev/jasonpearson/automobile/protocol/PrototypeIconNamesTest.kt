package dev.jasonpearson.automobile.protocol

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PrototypeIconNamesTest {
  @Test
  fun `removed and misspelled names fail at their path with suggestions`() {
    for ((name, suggestion) in listOf("settings_applications" to "settings", "homee" to "home")) {
      val spec =
        """{"id":"icons","window":{"placement":{"type":"fullscreen"}},"root":{"type":"icon","name":"$name"}}"""
      val result = PrototypeSpecValidator.validate(spec) as PrototypeSpecValidation.Failure
      assertEquals("root.name", result.error.path)
      assertTrue(result.error.message.contains("Unknown prototype icon name \"$name\""))
      assertTrue(result.error.message.contains("Did you mean"))
      assertTrue(result.error.message.contains("\"$suggestion\""))
      assertTrue(result.error.message.contains("automobile:prototype/icons"))
    }
  }
}
