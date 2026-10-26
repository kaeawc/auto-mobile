package dev.jasonpearson.automobile.protocol

import org.junit.Assert.*
import org.junit.Test

class PrototypeStringConditionsCapabilitiesTest {
  @Test
  fun `bundle requirements derive string conditions and ignore opaque names`() {
    val spec =
      """{"id":"strings","window":{"placement":{"type":"fullscreen"}},"state":{"value":"hello","contains":"literal"},"data":{"contains":"literal"},"root":{"type":"textField","stateKey":"value","errorWhen":{"key":"value","contains":"h"},"errorText":"Error"}}"""
    val refs = PrototypeBundleSpec.references(spec.toByteArray())
    assertEquals(
      listOf("prototype_data_model_v1", "prototype_string_conditions_v1"),
      PrototypeBundleCapabilities.required(refs),
    )
  }
}
