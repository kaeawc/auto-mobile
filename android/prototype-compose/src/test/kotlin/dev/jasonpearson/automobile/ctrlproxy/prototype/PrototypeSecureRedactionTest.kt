package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PrototypePlatform as Platform
import kotlinx.coroutines.CompletableDeferred
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

  @Test
  fun `platform args refuse secure state before dispatch and preserve ordinary bindings`() =
    runTest {
      val original = spec()
      val events = mutableListOf<PrototypeEvent>()
      val logs = mutableListOf<String>()
      val module = FakePlatformModule("share")
      module.execute = { PlatformCallResult.Success(JsonPrimitive("ok")) }
      val action =
        PrototypePlatformAction(
          "share.open",
          args = mapOf("text" to buildJsonObject { put("state", "token") }),
          into = "/data/result",
          onError = listOf(PrototypeEmitAction("refused")),
        )
      var sequence = 0L
      var callId = 0
      val runtime =
        PrototypeRuntime(
          original.copy(
            state = original.state!! + ("token" to PrototypeScalar.Text(SECRET)),
            requires = PrototypeRequires(platform = listOf("secureStorage", "share")),
          ),
          PrototypeEventSink { events += it },
          { 42L },
          { ++sequence },
          warn = { logs += it },
          requestScope = backgroundScope,
          platform = Platform(listOf(module)),
          newRequestId = { "secure-args-${++callId}" },
          monotonicMs = { testScheduler.currentTime },
        )
      runtime.handle(PrototypeInteraction.Tap(listOf(action)))
      runCurrent()
      assertTrue(module.calls.isEmpty())
      assertFalse("result" in runtime.current.spec.data.orEmpty())
      val failed =
        events.single { it.name == PrototypePlatform.CALL_EVENT_NAME }.payload!!.jsonObject
      assertEquals(JsonPrimitive("invalid_args"), failed.getValue("error").jsonObject["code"])
      assertTrue(events.any { it.name == "refused" })

      for ((binding, expected) in
        listOf(
          buildJsonObject { put("state", "public") } to "hello",
          buildJsonObject { put("value", "{token}") } to "{token}",
        )) {
        runtime.handle(
          PrototypeInteraction.Tap(listOf(action.copy(args = mapOf("text" to binding)))),
        )
        runCurrent()
        assertEquals(JsonPrimitive(expected), module.calls.last().args["text"])
      }
      assertEquals(2, module.calls.size)
      assertFalse(
        (events.joinToString { Json.encodeToString(it) } + runtime.current.spec.data + logs)
          .contains(SECRET),
      )
      runtime.close()
    }

  private fun conflictOps() = buildJsonArray {
    add(
      buildJsonObject {
        put("op", "replace")
        put("path", "/state/token")
        put("value", "host")
      },
    )
  }

  private fun uploadRequest(
    body: JsonObject = buildJsonObject {
      put("form", buildJsonObject { put("t", buildJsonObject { put("state", "token") }) })
    },
  ) =
    PrototypeRequestAction(
      url = "https://example.invalid/upload",
      method = "POST",
      via = "device",
      into = "/data/result",
      body = body,
      allowSecureInRequest = true,
      progressKey = "pct",
    )

  private fun uploadSpec(request: PrototypeRequestAction): PrototypeSpec {
    val original = spec()
    return original.copy(
      state =
        original.state!! +
          mapOf("token" to PrototypeScalar.Text(SECRET), "pct" to PrototypeScalar.Numeric(0.0)),
      root = PrototypeButtonNode(label = "Upload", onTap = listOf(request)),
    )
  }

  @Test
  fun `secure form upload progress and transport failure never expose request values`() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    val logs = mutableListOf<String>()
    val requests = mutableListOf<PrototypeHttpRequest>()
    val finish = CompletableDeferred<Unit>()
    val client = PrototypeHttpClient {
      requests += it
      finish.await()
      throw java.io.IOException(SECRET)
    }
    val request = uploadRequest()
    var sequence = 0L
    val runtime =
      PrototypeRuntime(
        uploadSpec(request),
        PrototypeEventSink { events += it },
        { 42L },
        { ++sequence },
        warn = { logs += it },
        httpClients = PrototypeHttpClients(client, client),
        requestScope = backgroundScope,
      )
    runtime.handle(PrototypeInteraction.Tap(listOf(request)))
    runCurrent()
    val sent = requests.single()
    assertEquals(mapOf("t" to SECRET), (sent.uploadBody as PrototypeUploadBody.Form).entries)
    val progress = checkNotNull(sent.onUploadProgress)
    progress(25)
    runCurrent()
    assertEquals(PrototypeScalar.Numeric(25.0), runtime.current.state["pct"])
    assertFalse(
      (events.joinToString { Json.encodeToString(it) } + runtime.current.spec.data).contains(
        SECRET,
      ),
    )
    finish.complete(Unit)
    runCurrent()
    val event = events.single { it.name == PrototypeRequests.EVENT_NAME }.payload!!.jsonObject
    val meta = runtime.current.spec.data!!.getValue("result__meta").jsonObject
    assertEquals(
      JsonPrimitive("Prototype request failed"),
      event.getValue("error").jsonObject["message"],
    )
    assertEquals(event["error"], meta["error"])
    assertTrue(logs.isNotEmpty())
    assertFalse(
      (events.joinToString { Json.encodeToString(it) } +
          runtime.current.spec.data +
          logs.joinToString())
        .contains(SECRET),
    )
    runtime.close()
  }

  @Test
  fun `secure upload binding and asset resolution failures are generic before transport`() =
    runTest {
      val bodies =
        listOf(
            """{"form":{"t":{"state":"token"},"missing":{"data":"/missing/$SECRET"}}}""",
            """{"multipart":[{"name":"t","value":{"state":"token"}},""" +
              """{"name":"file","file":{"asset":"$SECRET"}}]}""",
          )
          .map { Json.parseToJsonElement(it).jsonObject }
      for (body in bodies) {
        val events = mutableListOf<PrototypeEvent>()
        val logs = mutableListOf<String>()
        val client = PrototypeHttpClient { error("Resolution must fail before transport") }
        val request = uploadRequest(body)
        var sequence = 0L
        val runtime =
          PrototypeRuntime(
            uploadSpec(request),
            PrototypeEventSink { events += it },
            { 42L },
            { ++sequence },
            warn = { logs += it },
            httpClients = PrototypeHttpClients(client, client),
            requestScope = backgroundScope,
          )
        runtime.handle(PrototypeInteraction.Tap(listOf(request)))
        runCurrent()
        val event = events.single { it.name == PrototypeRequests.EVENT_NAME }.payload!!.jsonObject
        val meta = runtime.current.spec.data!!.getValue("result__meta").jsonObject
        assertEquals(JsonPrimitive("invalid_request"), event.getValue("error").jsonObject["code"])
        assertEquals(
          JsonPrimitive("Prototype request failed"),
          event.getValue("error").jsonObject["message"],
        )
        assertEquals(event["error"], meta["error"])
        assertFalse(
          (events.joinToString { Json.encodeToString(it) } +
              runtime.current.spec.data +
              logs.joinToString())
            .contains(SECRET),
        )
        runtime.close()
      }
    }

  @Test
  fun `secure form upload response headers are empty in metadata and absent from events`() =
    runTest {
      val events = mutableListOf<PrototypeEvent>()
      val logs = mutableListOf<String>()
      val client = PrototypeHttpClient {
        assertEquals(mapOf("t" to SECRET), (it.uploadBody as PrototypeUploadBody.Form).entries)
        PrototypeRequestResponse.Received(200, mapOf("x-echo" to SECRET), JsonPrimitive("ok"), 9)
      }
      val request = uploadRequest()
      var sequence = 0L
      val runtime =
        PrototypeRuntime(
          uploadSpec(request),
          PrototypeEventSink { events += it },
          { 42L },
          { ++sequence },
          warn = { logs += it },
          httpClients = PrototypeHttpClients(client, client),
          requestScope = backgroundScope,
        )
      runtime.handle(PrototypeInteraction.Tap(listOf(request)))
      runCurrent()
      val meta = runtime.current.spec.data!!.getValue("result__meta").jsonObject
      assertEquals(JsonObject(emptyMap()), meta["headers"])
      assertEquals(JsonPrimitive(200), meta["status"])
      assertEquals(JsonPrimitive("ok"), runtime.current.spec.data!!["result"])
      val event = events.single { it.name == PrototypeRequests.EVENT_NAME }.payload!!.jsonObject
      assertEquals(JsonPrimitive(200), event["status"])
      assertFalse("headers" in event)
      assertFalse(
        (events.joinToString { Json.encodeToString(it) } +
            runtime.current.spec.data +
            logs.joinToString())
          .contains(SECRET),
      )
      runtime.close()
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
