package dev.jasonpearson.automobile.protocol

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.SerializationException
import kotlinx.serialization.encodeToString
import org.junit.jupiter.api.Test

class WebSocketRequestApplicationsTest : WebSocketRequestTestSupport() {
  @Test
  fun `deserialize subscribe_storage`() {
    val message =
      """{"type":"subscribe_storage","requestId":"sub-1","packageName":"com.example.app","fileName":"settings.xml"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<SubscribeStorage>(request)
    assertEquals("sub-1", request.requestId)
    assertEquals("com.example.app", request.packageName)
    assertEquals("settings.xml", request.fileName)
  }

  @Test
  fun `deserialize unsubscribe_storage with subscriptionId matches the TS wire`() {
    // The TS client sends only subscriptionId ("packageName:fileName"). Verify the sealed class
    // decodes it without throwing; packageName/fileName are absent (the pre-migration no-op case).
    val message =
      """{"type":"unsubscribe_storage","requestId":"unsub-1","subscriptionId":"com.example.app:settings.xml"}"""
    val request = json.decodeFromString<WebSocketRequest>(message)

    assertIs<UnsubscribeStorage>(request)
    assertEquals("unsub-1", request.requestId)
    assertEquals("com.example.app:settings.xml", request.subscriptionId)
    assertEquals(null, request.packageName)
    assertEquals(null, request.fileName)
  }

  @Test
  fun `prototype requests round trip byte identical nested objects`() {
    val literals =
      listOf(
        """{"type":"show_prototype","requestId":"r1","spec":{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}}}""",
        // Same literal as the TypeScript "reset" wire fixture in ctrlProxyProtocol.test.ts.
        """{"type":"show_prototype","requestId":"r2","spec":{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}},"reset":true}""",
        """{"type":"dismiss_prototype","requestId":"r4","id":"panel"}""",
        """{"type":"dismiss_prototype","requestId":"r5","all":true}""",
      )
    literals.forEach { literal ->
      val request = json.decodeFromString<WebSocketRequest>(literal)
      assertEquals(literal, json.encodeToString(request))
      assertEquals(request, json.decodeFromString<WebSocketRequest>(json.encodeToString(request)))
    }
    val show = assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(literals.first()))
    assertEquals("panel", show.spec.id)
    assertEquals(PrototypeTextNode(text = "Hello"), show.spec.root)
    assertTrue(json.encodeToString<WebSocketRequest>(show).contains("\"spec\":{"))
    assertEquals(false, show.reset)
    assertEquals(
      true,
      assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(literals[1])).reset,
    )
    assertIs<DismissPrototype>(json.decodeFromString<WebSocketRequest>(literals.last()))
  }

  @Test
  fun `show_prototype displayId is optional on the wire and round trips`() {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}}"""
    // Absent stays absent: a request from a host that predates display targeting is unchanged.
    val absent = """{"type":"show_prototype","requestId":"r1","spec":$spec}"""
    val decoded = assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(absent))
    assertEquals(null, decoded.displayId)
    assertEquals(absent, json.encodeToString<WebSocketRequest>(decoded))
    // An explicit null decodes as the default display, and is not echoed back.
    val explicitNull =
      """{"type":"show_prototype","requestId":"r1","spec":$spec,"displayId":null}"""
    assertEquals(
      decoded,
      assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(explicitNull)),
    )
    // Same literal as the TypeScript wire fixture in ctrlProxyProtocol.test.ts.
    val explicit = """{"type":"show_prototype","requestId":"r1","spec":$spec,"displayId":2}"""
    val request = assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(explicit))
    assertEquals(2, request.displayId)
    assertEquals(explicit, json.encodeToString<WebSocketRequest>(request))
  }

  @Test
  fun `show_prototype replaceOthers defaults to omitted and false round trips`() {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}}"""
    val legacy = """{"type":"show_prototype","requestId":"r1","spec":$spec}"""
    val decoded = assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(legacy))
    assertTrue(decoded.replaceOthers)
    assertEquals(legacy, json.encodeToString<WebSocketRequest>(decoded))
    val explicitDefault =
      """{"type":"show_prototype","requestId":"r1","spec":$spec,"replaceOthers":true}"""
    assertEquals(decoded, json.decodeFromString<WebSocketRequest>(explicitDefault))
    assertEquals(legacy, json.encodeToString<WebSocketRequest>(decoded.copy(replaceOthers = true)))
    val additive =
      """{"type":"show_prototype","requestId":"r1","spec":$spec,"replaceOthers":false}"""
    val request = assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(additive))
    assertFalse(request.replaceOthers)
    assertEquals(additive, json.encodeToString<WebSocketRequest>(request))
  }

  @Test
  fun `show_prototype appearance is optional on the wire and round trips`() {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}}"""
    val absent = """{"type":"show_prototype","requestId":"r1","spec":$spec}"""
    assertNull(assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(absent)).appearance)
    for (value in PrototypeAppearanceOverride.entries) {
      val wire = value.name.lowercase()
      val literal =
        """{"type":"show_prototype","requestId":"r1","spec":$spec,"appearance":"$wire"}"""
      val request = assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(literal))
      assertEquals(value, request.appearance)
      assertEquals(literal, json.encodeToString<WebSocketRequest>(request))
    }
    // An unknown value fails the show instead of silently following the device.
    assertFailsWith<SerializationException> {
      json.decodeFromString<WebSocketRequest>(
        """{"type":"show_prototype","requestId":"r1","spec":$spec,"appearance":"sepia"}""",
      )
    }
  }

  @Test
  fun `inspect prototypes round trips a byte identical shared literal`() {
    val literal = """{"type":"inspect_prototypes","requestId":"r8"}"""
    val request = json.decodeFromString<WebSocketRequest>(literal)
    assertEquals(literal, json.encodeToString(request))
    assertEquals("r8", assertIs<InspectPrototypes>(request).requestId)
  }

  @Test
  fun `prototype asset requests round trip byte identical shared literals`() {
    val put =
      """{"type":"put_prototype_asset","requestId":"r6","id":"hero","mimeType":"image/png","dataBase64":"iVBORw0KGgo="}"""
    val remove = """{"type":"remove_prototype_asset","requestId":"r7","id":"hero"}"""
    for (literal in listOf(put, remove)) {
      val request = json.decodeFromString<WebSocketRequest>(literal)
      assertEquals(literal, json.encodeToString(request))
    }
    val decoded = assertIs<PutPrototypeAsset>(json.decodeFromString<WebSocketRequest>(put))
    assertEquals("r6", decoded.requestId)
    assertEquals("hero", decoded.id)
    assertEquals("image/png", decoded.mimeType)
    assertEquals("iVBORw0KGgo=", decoded.dataBase64)
    assertEquals(
      "r7",
      assertIs<RemovePrototypeAsset>(json.decodeFromString<WebSocketRequest>(remove)).requestId,
    )
  }

  @Test
  fun `prototype asset requests reject missing required fields`() {
    for (literal in
      listOf(
        """{"type":"put_prototype_asset","requestId":"r","mimeType":"image/png","dataBase64":"AA=="}""",
        """{"type":"put_prototype_asset","requestId":"r","id":"a","dataBase64":"AA=="}""",
        """{"type":"put_prototype_asset","requestId":"r","id":"a","mimeType":"image/png"}""",
        """{"type":"remove_prototype_asset","requestId":"r"}""",
      )) {
      assertFailsWith<SerializationException>(literal) {
        json.decodeFromString<WebSocketRequest>(literal)
      }
    }
  }

  @Test
  fun `put prototype asset never renders its payload`() {
    val payload = "SECRETBYTES".repeat(20)
    val request = PutPrototypeAsset("r", "hero", "image/png", payload)
    assertFalse(request.toString().contains("SECRETBYTES"))
    assertTrue(request.toString().contains("${payload.length} chars"))
  }

  @Test
  fun `request decoder remains lenient inside nested prototype spec`() {
    val literal =
      """{"type":"show_prototype","requestId":"r","spec":{"id":"panel","extra":true,"window":{"placement":{"type":"fullscreen","future":true}},"root":{"type":"text","text":"Hello","unknown":1}}}"""
    val request = assertIs<ShowPrototype>(json.decodeFromString<WebSocketRequest>(literal))
    assertEquals(PrototypeTextNode(text = "Hello"), request.spec.root)
  }
}
