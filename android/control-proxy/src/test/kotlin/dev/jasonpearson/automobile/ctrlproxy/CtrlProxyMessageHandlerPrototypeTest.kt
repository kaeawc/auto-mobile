package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.protocol.PrototypeResult
import dev.jasonpearson.automobile.protocol.PrototypeSpec
import dev.jasonpearson.automobile.protocol.PrototypeTextNode
import dev.jasonpearson.automobile.protocol.WebSocketRequest
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class CtrlProxyMessageHandlerPrototypeTest : CtrlProxyMessageHandlerFixtures() {
  @Test
  fun `show locale is forwarded unchanged and defaults to absent`() = runTest {
    val spec =
      """{"id":"locale","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}"""
    dispatch("""{"type":"show_prototype","spec":$spec,"locale":"pt-BR"}""")
    assertEquals("pt-BR", lastCall.second[6])
    dispatch("""{"type":"show_prototype","spec":$spec}""")
    assertNull(lastCall.second[6])
  }

  @Test
  fun `dispatch typed prototype requests`() = runTest {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"},"opacity":90},"root":{"type":"text","text":"Hello"}}"""
    dispatch("""{"type":"show_prototype","requestId":"s","spec":$spec}""")
    assertEquals("showPrototype", lastCall.first)
    assertEquals("s", lastCall.second[0])
    assertEquals("panel", (lastCall.second[1] as PrototypeSpec).id)
    assertEquals(PrototypeTextNode(text = "Hello"), (lastCall.second[1] as PrototypeSpec).root)
    assertEquals(false, lastCall.second[3])
    assertEquals(true, lastCall.second[5])
    dispatch("""{"type":"show_prototype","requestId":"add","spec":$spec,"replaceOthers":false}""")
    assertEquals(false, lastCall.second[5])
    dispatch("""{"type":"show_prototype","requestId":"r","spec":$spec,"reset":true}""")
    assertEquals("showPrototype", lastCall.first)
    assertEquals(true, lastCall.second[3])
    dispatch("""{"type":"dismiss_prototype","requestId":"d","id":"panel"}""")
    assertEquals("dismissPrototype", lastCall.first)
    assertEquals(listOf("d", "panel", null), lastCall.second)
    dispatch("""{"type":"dismiss_prototype","requestId":"a","all":true}""")
    assertEquals(listOf("a", null, true), lastCall.second)
  }

  @Test
  fun `show_prototype carries an absent or explicit displayId to the action`() = runTest {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}"""
    dispatch("""{"type":"show_prototype","requestId":"s","spec":$spec}""")
    assertNull(lastCall.second[2])
    dispatch("""{"type":"show_prototype","requestId":"s","spec":$spec,"displayId":null}""")
    assertNull(lastCall.second[2])
    // The handler's default SDK is Build.VERSION.SDK_INT (0 off-device); API 30+ may route.
    val api30 = CtrlProxyMessageHandler(actions, sdkInt = { 30 })
    api30.handleMessage(
      json.decodeFromString<WebSocketRequest>(
        """{"type":"show_prototype","requestId":"s","spec":$spec,"displayId":2}""",
      ),
    )
    assertEquals("showPrototype", lastCall.first)
    assertEquals(2, lastCall.second[2])
  }

  @Test
  fun `show_prototype rejects an unroutable displayId with a correlated result and no action`() =
    runTest {
      val spec =
        """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hi"}}"""
      for ((sdk, displayId) in listOf(29 to 7, 29 to -1, 30 to -1)) {
        val before = calls.size
        val response =
          CtrlProxyMessageHandler(actions, sdkInt = { sdk })
            .handleMessage(
              json.decodeFromString<WebSocketRequest>(
                """{"type":"show_prototype","requestId":"s","spec":$spec,"displayId":$displayId}""",
              ),
            )
        assertTrue(response is PrototypeResult)
        response as PrototypeResult
        assertFalse(response.success)
        assertEquals("s", response.requestId)
        assertTrue(response.error.orEmpty().contains("display", ignoreCase = true))
        assertEquals("No action on API $sdk displayId $displayId", before, calls.size)
      }
      // Display 0 is the default display on every API level.
      CtrlProxyMessageHandler(actions, sdkInt = { 29 })
        .handleMessage(
          json.decodeFromString<WebSocketRequest>(
            """{"type":"show_prototype","requestId":"s","spec":$spec,"displayId":0}""",
          ),
        )
      assertEquals("showPrototype", lastCall.first)
      assertEquals(0, lastCall.second[2])
    }

  @Test
  fun `patch prototype dispatches asynchronously with every patch field`() = runTest {
    val response =
      dispatchForResponse(
        """{"type":"patch_prototype","requestId":"r9","id":"orders","baseRevision":12,"ops":[{"op":"replace","path":"/data/cartCount","value":2}]}""",
      )
    assertNull(response)
    assertEquals("patchPrototype", lastCall.first)
    assertEquals(listOf("r9", "orders", 12L), lastCall.second.take(3))
    assertEquals(
      kotlinx.serialization.json.Json.parseToJsonElement(
        """[{"op":"replace","path":"/data/cartCount","value":2}]""",
      ),
      lastCall.second[3],
    )
  }

  @Test
  fun `dispatch saved prototype requests with all arguments`() = runTest {
    val spec =
      """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}"""
    dispatch(
      """{"type":"save_prototype","requestId":"save","spec":$spec,"label":"Panel","icon":"icon"}""",
    )
    assertEquals("savePrototype", lastCall.first)
    assertEquals(
      listOf("save", json.decodeFromString<PrototypeSpec>(spec), "Panel", "icon"),
      lastCall.second,
    )
    dispatch("""{"type":"save_prototype","spec":$spec,"label":"Panel"}""")
    assertEquals(
      listOf(null, json.decodeFromString<PrototypeSpec>(spec), "Panel", null),
      lastCall.second,
    )
    dispatch("""{"type":"pin_saved_prototype","requestId":"pin","id":"panel","icon":"icon"}""")
    assertEquals("pinSavedPrototype", lastCall.first)
    assertEquals(listOf("pin", "panel", "icon"), lastCall.second)
    dispatch("""{"type":"pin_saved_prototype","id":"panel"}""")
    assertEquals(listOf(null, "panel", null), lastCall.second)
    dispatch("""{"type":"list_saved_prototypes","requestId":"list"}""")
    assertEquals("listSavedPrototypes", lastCall.first)
    assertEquals(listOf("list"), lastCall.second)
    dispatch("""{"type":"delete_saved_prototype","requestId":"delete","id":"panel"}""")
    assertEquals("deleteSavedPrototype", lastCall.first)
    assertEquals(listOf("delete", "panel"), lastCall.second)
    dispatch("""{"type":"clear_prototype_storage","requestId":"clear","id":"panel"}""")
    assertEquals("clearPrototypeStorage", lastCall.first)
    assertEquals(listOf("clear", "panel"), lastCall.second)
  }

  @Test
  fun `dispatch inspect prototypes request`() = runTest {
    dispatch("""{"type":"inspect_prototypes","requestId":"i"}""")
    assertEquals("inspectPrototypes", lastCall.first)
    assertEquals(listOf<Any?>("i"), lastCall.second)
  }

  @Test
  fun `dispatch typed prototype asset requests`() = runTest {
    dispatch(
      """{"type":"put_prototype_asset","requestId":"p","id":"hero","mimeType":"image/png","dataBase64":"iVBORw0KGgo="}""",
    )
    assertEquals("putPrototypeAsset", lastCall.first)
    assertEquals(listOf("p", "hero", "image/png", "iVBORw0KGgo="), lastCall.second)
    dispatch("""{"type":"remove_prototype_asset","requestId":"r","id":"hero"}""")
    assertEquals("removePrototypeAsset", lastCall.first)
    assertEquals(listOf("r", "hero"), lastCall.second)
  }

  @Test
  fun `invalid prototype combinations return precise correlated failures without actions`() =
    runTest {
      val spec =
        """{"id":"panel","window":{"placement":{"type":"fullscreen"}},"root":{"type":"text","text":"Hello"}}"""
      val dismissError = "dismiss_prototype requires exactly one of id or all:true"
      val cases =
        listOf(
          """{"type":"dismiss_prototype","requestId":"bad"}""" to dismissError,
          """{"type":"dismiss_prototype","requestId":"bad","id":"panel","all":true}""" to
            dismissError,
          """{"type":"dismiss_prototype","requestId":"bad","all":false}""" to dismissError,
          """{"type":"dismiss_prototype","requestId":"bad","id":"panel","all":false}""" to
            dismissError,
        )
      for ((literal, error) in cases) {
        val result = dispatchForResponse(literal) as PrototypeResult
        assertEquals("bad", result.requestId)
        assertFalse(result.success)
        assertEquals(error, result.error)
      }
      assertTrue(calls.isEmpty())
    }

  @Test
  fun `prototype result frame carries failure and escaped echoed request id`() {
    val requestId = "quoted" + '"'
    val result =
      json.decodeFromString<WebSocketResponse>(
        prototypeResultFrame(requestId, false, "render failed"),
      ) as PrototypeResult
    assertEquals(requestId, result.requestId)
    assertFalse(result.success)
    assertEquals("render failed", result.error)
  }
}
