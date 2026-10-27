package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PrototypePlatformNamespacesTest {
  @Test
  fun `list slot namespaces retain native Android fields and only foreign glass metadata`() {
    val input =
      Json.parseToJsonElement(
        """{"root":{"type":"list","header":{"type":"box","android":{"indication":"none"},"ios":{"hover":"lift","glassGroup":{"spacing":12}}},"footer":{"type":"text","ios":{"hover":"lift"},"text":"Bye"}}}""",
      )
    val expected =
      Json.parseToJsonElement(
        """{"root":{"type":"list","header":{"type":"box","android":{"indication":"none"},"ios":{"glassGroup":{"spacing":12}}},"footer":{"type":"text","text":"Bye"}}}""",
      )
    assertEquals(expected, stripPlatformNamespaces(input))
  }

  @Test
  fun `retain Android node fields and strip foreign window and theme namespaces`() {
    val input =
      Json.parseToJsonElement(
        """{"window":{"ios":{},"android":{},"opacity":100},"theme":{"ios":{}},"data":{"ios":{"hover":"lift"}},"root":{"type":"stack","ios":{},"screens":{"home":{"type":"column","android":{},"children":[{"type":"text","ios":{},"text":"Hi","repeat":{"items":[{"ios":1}]}}]}}}}""",
      )
    val expected =
      Json.parseToJsonElement(
        """{"window":{"opacity":100},"data":{"ios":{"hover":"lift"}},"root":{"type":"stack","screens":{"home":{"type":"column","android":{},"children":[{"type":"text","text":"Hi","repeat":{"items":[{"ios":1}]}}]}}}}""",
      )
    assertEquals(expected, stripPlatformNamespaces(input))
    // A theme that held only a namespace is dropped: an empty theme is invalid.
    assertNull(stripPlatformNamespaces(input).jsonObject["theme"])
  }

  @Test
  fun `accessory capabilities are ignored and list slots decode`() {
    val spec =
      """{"id":"ns","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi","ios":{"bottomAccessory":{"type":"text","text":"Hidden","android":{"indication":"none"},"onTap":[{"type":"emit","name":"hidden","context":{"hidden":{"data":"/hidden"}}}]}}}}"""
    val refs = PrototypeBundleSpec.references(spec.toByteArray())
    assertEquals(
      listOf("prototype_platform_namespace_v1"),
      PrototypeBundleCapabilities.required(refs),
    )
    assertEquals(
      setOf("prototype_platform_namespace_v1"),
      PrototypeStrictPolicy.required(refs.spec),
    )
    val slots =
      """{"id":"slots","data":{"rows":[]},"window":{"placement":{"type":"fullscreen"}},"root":{"type":"list","repeat":{"items":{"path":"/rows"},"as":"row","key":"id"},"children":[{"type":"text","text":"Row"}],"header":{"type":"text","text":"Hi","ios":{"hover":"lift"}},"footer":{"type":"text","text":"Bye","ios":{}}}}"""
    val result = PrototypeSpecValidator.validate(slots)
    org.junit.jupiter.api.Assertions.assertTrue(
      result is PrototypeSpecValidation.Success,
      result.toString(),
    )
  }
}
