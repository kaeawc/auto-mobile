package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import java.io.File
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

class PrototypeEmbeddedRoutingTest {
  companion object {
    private lateinit var cases: List<JsonObject>

    @JvmStatic
    @BeforeClass
    fun loadFixtureAndWarmValidator() {
      val fixture =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-embedded-routing/routing.json") }
          .first { it.isFile }
      cases = Json.parseToJsonElement(fixture.readText()).jsonArray.map { it.jsonObject }
      PrototypeSpecValidator.validate("{}")
    }
  }

  private class FakeHttp : PrototypeHttpClient {
    val requests = mutableListOf<PrototypeHttpRequest>()

    override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
      requests += request
      return PrototypeRequestResponse.Received(200, emptyMap(), JsonPrimitive("ok"), 9)
    }
  }

  @Test
  fun `embedded routes reuse the exact supplied client instances`() {
    for (case in cases) {
      val name = case.getValue("name").jsonPrimitive.content
      val device = FakeHttp()
      val handler = FakeHttp()
      val clients =
        PrototypeHttpClients.forEmbedded(
          device,
          if (case.getValue("hostHandler").jsonPrimitive.boolean) handler else null,
        )
      val via = case.getValue("via").jsonPrimitive.contentOrNull ?: "host"
      val expected =
        if (case.getValue("expectedRoute").jsonPrimitive.content == "handler") handler else device
      assertSame(name, expected, clients.forVia(via))
      assertSame(name, device, clients.device)
    }
  }

  @Test
  fun `shared routing cases decode and complete through the embedded runtime`() = runTest {
    for (case in cases) {
      val name = case.getValue("name").jsonPrimitive.content
      val device = FakeHttp()
      val handler = FakeHttp()
      val events = mutableListOf<PrototypeEvent>()
      val via = case.getValue("via").jsonPrimitive.contentOrNull
      val viaField = if (via == null) "" else ",\"via\":\"$via\""
      val validation =
        PrototypeSpecValidator.validate(
          """{"id":"embedded","window":{"placement":{"type":"fullscreen"}},"state":{"status":"idle"},"data":{},"root":{"type":"button","label":"Go","onTap":[{"type":"request","url":"https://example.test/feed","into":"/data/feed","statusKey":"status"$viaField}]}}""",
        )
      val spec =
        (validation as? PrototypeSpecValidation.Success)?.spec ?: error("$name: $validation")
      var sequence = 0L
      val runtime =
        PrototypeRuntime(
          spec,
          PrototypeEventSink { events += it },
          { 1_000L },
          { ++sequence },
          warn = { fail(it) },
          httpClients =
            PrototypeHttpClients.forEmbedded(
              device,
              if (case.getValue("hostHandler").jsonPrimitive.boolean) handler else null,
            ),
          requestScope = backgroundScope,
          newRequestId = { "r-1" },
        )

      runtime.handle(PrototypeInteraction.Tap(checkNotNull(spec.root.onTap)))
      runCurrent()

      val useHandler = case.getValue("expectedRoute").jsonPrimitive.content == "handler"
      assertEquals(name, if (useHandler) 0 else 1, device.requests.size)
      assertEquals(name, if (useHandler) 1 else 0, handler.requests.size)
      assertEquals(name, PrototypeScalar.Text("success"), runtime.current.state["status"])
      assertEquals(name, JsonPrimitive("ok"), runtime.current.spec.data?.get("feed"))
      val event = events.single { it.name == PrototypeRequests.EVENT_NAME }.payload!!.jsonObject
      assertEquals(name, JsonPrimitive(via ?: "host"), event["via"])
      assertEquals(name, JsonPrimitive("success"), event["outcome"])
      assertEquals(name, JsonPrimitive(200), event["status"])
      assertEquals(name, JsonPrimitive(9), event["durationMs"])
    }
  }
}
