package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeFakeMediaEngine.Event
import dev.jasonpearson.automobile.protocol.PrototypeFakeMediaEngine.Failure
import dev.jasonpearson.automobile.protocol.PrototypeFakeMediaEngine.SimRequest
import dev.jasonpearson.automobile.protocol.PrototypeFakeMediaEngine.State
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeFakeMediaEngineTest {
  private val cases: List<JsonObject> by lazy {
    val fixture =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-media-sim/scripts.json") }
        .first { it.isFile }
    Json.parseToJsonElement(fixture.readText()).jsonArray.map { it.jsonObject }
  }

  private fun JsonObject.text(key: String): String? = get(key)?.jsonPrimitive?.contentOrNull

  private fun JsonObject.number(key: String): Long? = get(key)?.jsonPrimitive?.longOrNull

  private fun run(engine: PrototypeFakeMediaEngine, step: JsonObject): Failure? {
    val player = step.text("player").orEmpty()
    return when (step.text("op")) {
      "load" -> {
        val loop = step["loop"]?.jsonPrimitive?.boolean ?: false
        engine.load(player, step.number("durationMs")!!, loop)
        null
      }
      "play" -> engine.play(player)
      "pause" -> engine.pause(player)
      "seek" -> engine.seek(player, step.number("positionMs")!!)
      "advance" -> {
        engine.advance(step.number("ms")!!)
        null
      }
      "release" -> engine.release(player)
      else -> {
        val data = step.getValue("data").jsonObject
        engine.simulate(
          SimRequest(
            event = step.text("event")!!,
            player = data.text("player").orEmpty(),
            status = data.text("status"),
            code = data.text("code"),
            advanceMs = data.number("advanceMs"),
          ),
        )
      }
    }
  }

  private fun value(element: JsonElement): Any {
    val primitive = element as JsonPrimitive
    return when {
      primitive.isString -> primitive.content
      primitive.booleanOrNull != null -> primitive.boolean
      else -> primitive.long
    }
  }

  private fun event(json: JsonObject) =
    Event(
      json.text("name")!!,
      json.getValue("payload").jsonObject.mapValues { value(it.value) },
    )

  private fun state(json: JsonObject) =
    State(
      playing = json.getValue("playing").jsonPrimitive.boolean,
      positionMs = json.number("positionMs")!!,
      durationMs = json.number("durationMs")!!,
      buffering = json.getValue("buffering").jsonPrimitive.boolean,
      status = json.text("status")!!,
      error = json.text("error"),
    )

  @Test
  fun `shared scripts produce the same events and platform media state on every platform`() {
    assertTrue(cases.isNotEmpty())
    for (case in cases) {
      val name = case.text("name")!!
      val engine = PrototypeFakeMediaEngine()
      for (step in case.getValue("steps").jsonArray.map { it.jsonObject }) {
        assertEquals("$name: $step", step.text("error"), run(engine, step)?.code)
      }
      val expected = case.getValue("expected").jsonObject
      assertEquals(
        name,
        expected.getValue("events").jsonArray.map { event(it.jsonObject) },
        engine.events,
      )
      assertEquals(
        name,
        expected.getValue("state").jsonObject.getValue("players").jsonObject.mapValues {
          state(it.value.jsonObject)
        },
        engine.snapshot(),
      )
    }
  }

  @Test
  fun `error codes come from the contract`() {
    assertEquals(
      listOf("source_not_found", "decode", "network", "unsupported_format", "blocked_egress"),
      PrototypeFakeMediaEngine.ERROR_CODES,
    )
  }

  @Test
  fun `release drops the player and later calls refuse it`() {
    val engine = PrototypeFakeMediaEngine()
    engine.load("a", 1000)
    engine.load("b", 2000)
    assertNull(engine.release("a"))
    assertEquals(listOf("b"), engine.snapshot().keys.toList())
    assertEquals(Failure.UNKNOWN_PLAYER, engine.play("a"))
  }
}
