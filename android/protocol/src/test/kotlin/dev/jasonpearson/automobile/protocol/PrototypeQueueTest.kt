package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeQueue.Op
import dev.jasonpearson.automobile.protocol.PrototypeQueue.Repeat
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PrototypeQueueTest {
  private val cases: List<JsonObject> by lazy {
    val fixture =
      generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-media-queue/operations.json") }
        .first { it.isFile }
    Json.parseToJsonElement(fixture.readText()).jsonArray.map { it.jsonObject }
  }

  /** Replays a fixed sequence, failing on a value out of range or a draw past its end. */
  private class FakeRandom(private val values: List<Int>) : PrototypeQueue.Random {
    var drawn = 0
      private set

    override fun nextInt(bound: Int): Int {
      val value = values[drawn++]
      assertTrue("random $value out of 0 until $bound", value in 0 until bound)
      return value
    }
  }

  private val argumentFreeOps =
    mapOf(
      "play" to Op.Play,
      "pause" to Op.Pause,
      "next" to Op.Next,
      "previous" to Op.Previous,
      "ended" to Op.Ended,
    )

  private fun op(json: JsonObject): Op {
    val name = json.getValue("op").jsonPrimitive.content
    return argumentFreeOps[name] ?: opWithArguments(name, json)
  }

  private fun opWithArguments(name: String, json: JsonObject): Op {
    fun primitive(key: String) = json.getValue(key).jsonPrimitive
    return when (name) {
      "seek" -> Op.Seek(primitive("positionMs").long)
      "skipTo" -> Op.SkipTo(primitive("itemId").content)
      "setShuffle" -> Op.SetShuffle(primitive("shuffle").boolean)
      "setRepeat" -> Op.SetRepeat(Repeat.fromWire(primitive("repeat").content) ?: error("repeat"))
      "setRate" -> Op.SetRate(primitive("rate").double)
      "setSleepTimer" -> sleepTimer(json.getValue("timer").jsonObject)
      "advance" -> Op.Advance(primitive("ms").long)
      "sync" -> Op.Sync(json.getValue("items").jsonArray.map { it.jsonPrimitive.content })
      else -> error("unknown op $name")
    }
  }

  private fun sleepTimer(timer: JsonObject) =
    Op.SetSleepTimer(
      ms = timer["ms"]?.jsonPrimitive?.long ?: 0,
      endOfItem = timer["endOfItem"]?.jsonPrimitive?.booleanOrNull == true,
    )

  private fun snapshot(result: PrototypeQueue.Result): Map<String, Any?> {
    val state = result.state
    return mapOf(
      "currentItemId" to state.currentItemId,
      "currentIndex" to state.currentIndex,
      "playing" to state.playing,
      "positionMs" to state.positionMs,
      "shuffle" to state.shuffle,
      "repeat" to state.repeat.wire,
      "rate" to state.rate,
      "sleepRemainingMs" to state.sleepRemainingMs,
      "sleepEndOfItem" to (state.sleep == PrototypeQueue.Sleep.EndOfItem),
      "order" to state.order,
      "itemChanged" to result.itemChanged,
      "error" to result.error,
    )
  }

  private fun expected(json: JsonObject): Map<String, Any?> {
    fun primitive(key: String) = json.getValue(key) as? JsonPrimitive
    fun nullable(key: String) = json.getValue(key).takeUnless { it is JsonNull }?.jsonPrimitive
    return mapOf(
      "currentItemId" to nullable("currentItemId")?.content,
      "currentIndex" to primitive("currentIndex")!!.int,
      "playing" to primitive("playing")!!.boolean,
      "positionMs" to primitive("positionMs")!!.long,
      "shuffle" to primitive("shuffle")!!.boolean,
      "repeat" to primitive("repeat")!!.content,
      "rate" to primitive("rate")!!.double,
      "sleepRemainingMs" to nullable("sleepRemainingMs")?.long,
      "sleepEndOfItem" to primitive("sleepEndOfItem")!!.boolean,
      "order" to (json.getValue("order") as JsonArray).map { it.jsonPrimitive.content },
      "itemChanged" to primitive("itemChanged")!!.boolean,
      "error" to nullable("error")?.content,
    )
  }

  @Test
  fun `shared fixtures replay to the same queue state on every platform`() {
    assertTrue(cases.isNotEmpty())
    for (case in cases) {
      val name = case.getValue("name").jsonPrimitive.content
      val random = FakeRandom(case.getValue("random").jsonArray.map { it.jsonPrimitive.int })
      var state =
        PrototypeQueue.start(case.getValue("items").jsonArray.map { it.jsonPrimitive.content })
      for ((index, step) in case.getValue("steps").jsonArray.withIndex()) {
        val result =
          PrototypeQueue.apply(state, op(step.jsonObject.getValue("op").jsonObject), random)
        assertEquals(
          "$name, step $index",
          expected(step.jsonObject.getValue("expect").jsonObject),
          snapshot(result),
        )
        state = result.state
      }
      assertEquals(
        "$name consumes every random draw",
        case.getValue("random").jsonArray.size,
        random.drawn,
      )
    }
  }

  @Test
  fun `a sleep timer driven by a fake clock pauses exactly when it reaches zero`() {
    val clockTicks = List(60) { 1_000L }
    var state =
      PrototypeQueue.apply(
          PrototypeQueue.start(listOf("a")),
          Op.SetSleepTimer(ms = 30_000),
          NO_RANDOM,
        )
        .state
    state = PrototypeQueue.apply(state, Op.Play, NO_RANDOM).state
    val pausedAfter =
      clockTicks.indices.first { tick ->
        state = PrototypeQueue.apply(state, Op.Advance(clockTicks[tick]), NO_RANDOM).state
        !state.playing
      }
    assertEquals(29, pausedAfter)
    assertEquals(null, state.sleep)
  }

  @Test
  fun `shuffling a long queue is a permutation that keeps the current item first`() {
    val items = List(50) { "i$it" }
    val state =
      PrototypeQueue.apply(
          PrototypeQueue.start(items).copy(currentItemId = "i7"),
          Op.SetShuffle(true),
        ) { bound ->
          bound / 2
        }
        .state
    assertEquals("i7", state.order.first())
    assertEquals(items.toSet(), state.order.toSet())
    assertEquals(items.size, state.order.size)
  }

  private companion object {
    val NO_RANDOM = PrototypeQueue.Random { error("no random draw expected") }
  }
}
