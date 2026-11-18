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
      val client = PrototypeHttpClient { throw java.io.IOException(SECRET) }
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
      assertTrue(events.any { it.name == PrototypeRequests.EVENT_NAME })
      assertTrue(logs.isNotEmpty())
      val wire =
        events.joinToString { Json.encodeToString(it) } +
          runtime.current.spec.data.toString() +
          logs.joinToString()
      assertFalse(wire.contains(SECRET))
      runtime.close()
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
