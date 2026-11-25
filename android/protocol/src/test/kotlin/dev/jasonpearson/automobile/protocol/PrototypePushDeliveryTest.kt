package dev.jasonpearson.automobile.protocol

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory

/**
 * The push delivery (#14285) replays `push/traces.json`, the traces the TypeScript reference
 * replays: each step applies the handler's data and state writes with `{event}` read from the push,
 * then checks `/data`, state, the delivered event and the alert.
 */
class PrototypePushDeliveryTest {
  companion object {
    @JvmStatic
    @BeforeAll
    fun warmValidator() {
      PrototypeSpecValidator.validate("{}")
    }
  }

  private val traces: JsonArray =
    Json.parseToJsonElement(File(fixtureDirectory(), "push/traces.json").readText()).jsonArray

  private class Inputs(
    private val state: Map<String, JsonElement>,
    private val data: JsonObject,
    private val push: JsonObject,
  ) : EmitContextInputs {
    override fun state(key: String): JsonElement? = state[key]

    override fun page(id: String): Int? = null

    override fun data(pointer: String): JsonElement? = PrototypeDataPointer.resolve(data, pointer)

    override fun event(pointer: String): JsonElement? = PrototypeDataPointer.resolve(push, pointer)
  }

  /** Applies one handler action; the traces use only `appendData` and `setState`. */
  private fun applyAction(
    action: JsonObject,
    push: JsonObject,
    data: JsonObject,
    state: MutableMap<String, JsonElement>,
  ): JsonObject {
    val binding = action.getValue("value").jsonObject
    val resolved = PrototypeDataWriter.resolveValue(binding, Inputs(state, data, push))
    val value = (resolved as PrototypeDataValue.Resolved).value
    return when (val type = action.getValue("type").jsonPrimitive.content) {
      "setState" -> {
        state[action.getValue("key").jsonPrimitive.content] = value
        data
      }
      "appendData" -> {
        val write = PrototypeDataWrite.Append(action.getValue("path").jsonPrimitive.content, value)
        (PrototypeDataWriter.apply(data, write) as PrototypeDataWriteResult.Success).data
      }
      else -> error("Unexpected handler action $type")
    }
  }

  private fun handlerOf(spec: JsonObject): JsonArray? =
    ((spec["platform"] as? JsonObject)?.get("on") as? JsonObject)?.get(PrototypePushDelivery.EVENT)
      as? JsonArray

  @TestFactory
  fun `shared push traces`(): List<DynamicTest> = traces.map { raw ->
    val trace = raw.jsonObject
    DynamicTest.dynamicTest(trace.getValue("name").jsonPrimitive.content) {
      val spec = trace.getValue("spec").jsonObject
      val handler = handlerOf(spec)
      var data = spec["data"] as? JsonObject ?: JsonObject(emptyMap())
      val state = (spec["state"] as? JsonObject ?: JsonObject(emptyMap())).toMutableMap()
      trace.getValue("steps").jsonArray.forEachIndexed { index, rawStep ->
        val step = rawStep.jsonObject
        val push = step.getValue("push").jsonObject
        handler?.forEach { action -> data = applyAction(action.jsonObject, push, data, state) }
        val expect = step.getValue("expect").jsonObject
        assertEquals(expect.getValue("data"), data, "step $index data")
        assertEquals(expect.getValue("state"), JsonObject(state), "step $index state")
        // The traces push over the live connection to a foreground prototype.
        val outcome =
          PrototypePushDelivery.deliver(
            handled = handler != null,
            payload = push,
            appState = "active",
            route = PrototypePushRoute.CONNECTION,
          )
        val delivered = buildJsonObject {
          put("kind", "emit")
          put("name", "prototype_platform_event")
          put("payload", outcome.event)
        }
        assertEquals(expect.getValue("events"), JsonArray(listOf(delivered)), "step $index event")
        val notification = push["notification"]
        assertEquals(if (handler == null) notification else null, outcome.alert, "step $index")
      }
    }
  }

  @Test
  fun `the unhandled trace posts its notification as an alert`() {
    val trace = traces.single {
      it.jsonObject.getValue("name").jsonPrimitive.content ==
        "an unhandled push with a notification changes no data"
    }
    val push = trace.jsonObject.getValue("steps").jsonArray.single().jsonObject.getValue("push")
    val outcome =
      PrototypePushDelivery.deliver(false, push.jsonObject, "active", PrototypePushRoute.CONNECTION)
    assertEquals(
      buildJsonObject {
        put("title", "Ada")
        put("body", "Hi")
        put("channel", "chat")
      },
      outcome.alert,
    )
  }

  @Test
  fun `the connection route is foreground only while active and the system route is a notification`() {
    val states = listOf("active", "inactive", "background")
    assertEquals(
      listOf("foreground", "background", "background"),
      states.map { PrototypePushDelivery.delivery(PrototypePushRoute.CONNECTION, it) },
    )
    assertEquals(
      listOf("notification", "notification", "notification"),
      states.map { PrototypePushDelivery.delivery(PrototypePushRoute.SYSTEM, it) },
    )
  }

  @Test
  fun `a handled push or one without a notification posts no alert`() {
    val notification = buildJsonObject { put("title", "Ada") }
    val withAlert = buildJsonObject {
      put("type", "message")
      put("data", JsonObject(emptyMap()))
      put("notification", notification)
    }
    val plain = buildJsonObject {
      put("type", "message")
      put("data", JsonObject(emptyMap()))
    }
    assertNull(
      PrototypePushDelivery.deliver(true, withAlert, "active", PrototypePushRoute.CONNECTION).alert,
    )
    assertNull(
      PrototypePushDelivery.deliver(false, plain, "background", PrototypePushRoute.SYSTEM).alert,
    )
    assertEquals(
      notification,
      PrototypePushDelivery.deliver(false, withAlert, "inactive", PrototypePushRoute.SYSTEM).alert,
    )
  }
}
