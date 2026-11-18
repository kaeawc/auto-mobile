package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeSecureRedactionTest {
  companion object {
    private const val SECRET = "private-token-14321"

    @JvmStatic
    @BeforeClass
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private fun spec() =
    (PrototypeSpecValidator.validate(
        """{"id":"vault","window":{"placement":{"type":"fullscreen"}},"requires":{"platform":["secureStorage"]},"state":{"token":"","public":"hello"},"storage":{"version":1,"keys":["state:public"],"secure":["state:token"]},"root":{"type":"text","text":"Vault"}}""",
      ) as PrototypeSpecValidation.Success)
      .spec

  private fun conflictOps() = buildJsonArray {
    add(
      buildJsonObject {
        put("op", "replace")
        put("path", "/state/token")
        put("value", "host")
      },
    )
  }

  @Test
  fun `request failure metadata events and warnings cannot expose opted in secure arguments`() =
    runTest {
      val events = mutableListOf<PrototypeEvent>()
      val logs = mutableListOf<String>()
      val request =
        PrototypeRequestAction(
          url = "https://example.invalid/{token}",
          into = "/data/result",
          allowSecureInRequest = true,
        )
      var transportUrl: String? = null
      val client = PrototypeHttpClient {
        transportUrl = it.url
        throw java.io.IOException(SECRET)
      }
      var sequence = 0L
      val original = spec()
      val runtime =
        PrototypeRuntime(
          original.copy(
            state = original.state!! + ("token" to PrototypeScalar.Text(SECRET)),
            root = PrototypeButtonNode(label = "Go", onTap = listOf(request)),
          ),
          PrototypeEventSink { events += it },
          { 42L },
          { ++sequence },
          warn = { logs += it },
          httpClients = PrototypeHttpClients(client, client),
          requestScope = backgroundScope,
        )
      runtime.handle(PrototypeInteraction.Tap(listOf(request)))
      runCurrent()
      assertEquals("https://example.invalid/$SECRET", transportUrl)
      val event = events.single { it.name == PrototypeRequests.EVENT_NAME }
      assertEquals(JsonPrimitive("[redacted]"), event.payload!!.jsonObject["url"])
      assertEquals(
        JsonPrimitive("Prototype request failed"),
        event.payload!!.jsonObject.getValue("error").jsonObject["message"],
      )
      val metadata = runtime.current.spec.data!!.getValue("result__meta").jsonObject
      assertEquals(
        JsonPrimitive("Prototype request failed"),
        metadata.getValue("error").jsonObject["message"],
      )
      assertTrue(logs.isNotEmpty())
      val wire =
        events.joinToString { Json.encodeToString(it) } +
          runtime.current.spec.data.toString() +
          logs.joinToString()
      assertFalse(wire.contains(SECRET))
      runtime.close()
    }

  @Test
  fun `validated data actions refuse secure bindings and preserve ordinary state writes`() =
    runTest {
      val original = spec()
      val actions =
        listOf(
          PrototypeSetDataAction("/data/copy", buildJsonObject { put("state", "token") }),
          PrototypeSetDataAction("/data/public", buildJsonObject { put("state", "public") }),
        )
      val validated =
        PrototypeSpecValidator.validate(
          Json.encodeToString(
            original.copy(root = PrototypeButtonNode(label = "Copy", onTap = actions)),
          ),
        ) as PrototypeSpecValidation.Success
      val events = mutableListOf<PrototypeEvent>()
      val logs = mutableListOf<String>()
      var sequence = 0L
      val runtime =
        PrototypeRuntime(
          validated.spec.copy(
            state = validated.spec.state!! + ("token" to PrototypeScalar.Text(SECRET)),
          ),
          PrototypeEventSink { events += it },
          { 42L },
          { ++sequence },
          warn = { logs += it },
          requestScope = backgroundScope,
        )
      runtime.handle(PrototypeInteraction.Tap((validated.spec.root as PrototypeButtonNode).onTap!!))
      assertFalse("copy" in runtime.current.spec.data!!.keys)
      assertEquals(JsonPrimitive("hello"), runtime.current.spec.data!!["public"])
      val change = events.single { it.kind == PrototypeEventKind.CHANGE }
      assertEquals(JsonPrimitive("hello"), change.payload!!.jsonObject["value"])
      assertFalse(events.joinToString { Json.encodeToString(it) }.contains(SECRET))
      assertEquals(listOf("Prototype action could not be completed"), logs)
      runtime.close()
    }

  @Test
  fun `secure request response headers are absent from metadata and events for every status`() =
    runTest {
      for (status in listOf(200, 400)) {
        val events = mutableListOf<PrototypeEvent>()
        val request =
          PrototypeRequestAction(
            url = "https://example.invalid/{token}",
            into = "/data/result",
            allowSecureInRequest = true,
          )
        val client = PrototypeHttpClient {
          assertEquals("https://example.invalid/$SECRET", it.url)
          PrototypeRequestResponse.Received(
            status,
            mapOf("x-echo" to it.url),
            JsonPrimitive("ok"),
            9,
          )
        }
        val original = spec()
        var sequence = 0L
        val runtime =
          PrototypeRuntime(
            original.copy(state = original.state!! + ("token" to PrototypeScalar.Text(SECRET))),
            PrototypeEventSink { events += it },
            { 42L },
            { ++sequence },
            httpClients = PrototypeHttpClients(client, client),
            requestScope = backgroundScope,
          )
        runtime.handle(PrototypeInteraction.Tap(listOf(request)))
        val replacement =
          PrototypeRuntime(
            original.copy(storage = null, requires = null),
            PrototypeEventSink { events += it },
            { 42L },
            { ++sequence },
            requestScope = backgroundScope,
          )
        runtime.handOverRequests(replacement)
        runtime.close()
        runCurrent()
        val meta = replacement.current.spec.data!!.getValue("result__meta").jsonObject
        assertEquals(JsonPrimitive(status), meta["status"])
        assertTrue(meta["headers"]?.jsonObject.orEmpty().isEmpty())
        val event = events.single { it.name == PrototypeRequests.EVENT_NAME }.payload!!.jsonObject
        assertEquals(JsonPrimitive(status), event["status"])
        assertEquals(meta["error"], event["error"])
        if (status == 400)
          assertEquals(
            JsonPrimitive(PrototypeRequestErrorCode.HTTP_ERROR.wireValue),
            meta.getValue("error").jsonObject["code"],
          )
        assertTrue(events.any { it.kind == PrototypeEventKind.CHANGE })
        assertFalse((events.joinToString { Json.encodeToString(it) } + meta).contains(SECRET))
        replacement.close()
      }
    }

  @Test
  fun `single multi-key custom and dismiss events and conflicts never expose secure values`() =
    runTest {
      val spec = spec()
      val events = mutableListOf<PrototypeEvent>()
      val logs = mutableListOf<String>()
      var sequence = 0L
      val runtime =
        PrototypeRuntime(
          spec,
          PrototypeEventSink { events += it },
          { 42L },
          { ++sequence },
          warn = { logs += it },
          requestScope = backgroundScope,
        )
      runtime.handle(PrototypeInteraction.TextChange("token", SECRET))
      assertEquals(PrototypeScalar.Text(SECRET), runtime.current.state["token"])
      assertFalse("token" in runtime.publicState)
      assertEquals(JsonPrimitive("token"), events.last().payload!!.jsonObject["key"])
      assertFalse("value" in events.last().payload!!.jsonObject)
      runtime.handle(
        PrototypeInteraction.Tap(
          listOf(
            PrototypeSetStateAction("token", PrototypeScalar.Text("${SECRET}2")),
            PrototypeSetStateAction("public", PrototypeScalar.Text("updated")),
          ),
        ),
      )
      runtime.handle(PrototypeInteraction.Tap(listOf(PrototypeEmitAction("custom"))))
      val conflict =
        runtime.patch(0, conflictOps(), Json) { spec } as PrototypeRuntime.PatchResult.Conflict
      assertTrue(conflict.state.isEmpty())
      runtime.handle(
        PrototypeInteraction.TimerFire(
          listOf(PrototypeSetStateAction("token", PrototypeScalar.Numeric(3.0))),
        ),
      )
      assertTrue(logs.isNotEmpty())
      runtime.dismiss()
      val wire =
        events.joinToString { Json.encodeToString(it) } +
          Json.encodeToString(runtime.publicState) +
          logs.joinToString()
      assertFalse(wire.contains(SECRET))
      assertFalse(wire.contains("private-token"))
      assertEquals(PrototypeEventKind.DISMISSED, events.last().kind)
      runtime.close()
    }
}
