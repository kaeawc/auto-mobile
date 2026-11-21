package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.fixtureFile
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** Replays the shared `override-*` fixtures (#14316) against the Kotlin runtime override. */
@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeDeviceStatusOverrideTest {
  private data class Replay(
    val updates: List<JsonObject>,
    val error: Pair<Int, String>? = null,
  )

  private fun fixture(name: String): JsonObject =
    Json.parseToJsonElement(fixtureFile("prototype-device-status/$name").readText()).jsonObject

  private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content

  private fun replay(module: String, platform: String, inputs: List<JsonObject>): Replay {
    val override = DeviceStatusOverride(platform)
    val updates = mutableListOf<JsonObject>()
    inputs.forEachIndexed { index, input ->
      val before = override.shown
      input["reading"]?.let { override.reading(it.jsonObject) }
      input["mode"]?.let {
        override.mode(DeviceStatusMode.valueOf(it.jsonPrimitive.content.uppercase()))
      }
      input["seed"]?.let { seed ->
        override.seed(module, seed.jsonObject)?.let {
          return Replay(updates, index to "inputs[$index].${it.path}")
        }
      }
      val shown = override.shown
      if (shown != null && shown != before) {
        updates += buildJsonObject {
          put("timestampMs", input.getValue("timestampMs"))
          put("values", shown)
        }
      }
    }
    return Replay(updates)
  }

  private fun inputs(case: JsonObject) = case.getValue("inputs").jsonArray.map { it.jsonObject }

  @Test
  fun `seed fixtures replay to the expected updates and debounced events`() = runTest {
    val files =
      fixtureFile("prototype-device-status")
        .listFiles()!!
        .filter { it.name.startsWith("override-seed-") }
        .sortedBy { it.name }
    assertEquals(3, files.size)
    for (file in files) {
      val fixture = fixture(file.name)
      val replay = replay(fixture.text("module"), fixture.text("platform"), inputs(fixture))
      assertNull(file.name, replay.error)
      assertEquals(
        file.name,
        fixture.getValue("expectedUpdates").jsonArray.toList(),
        replay.updates,
      )
      assertEquals(
        file.name,
        fixture.getValue("expectedEvents").jsonArray.toList(),
        events(fixture.text("module"), replay.updates),
      )
    }
  }

  @Test
  fun `rejection fixtures refuse at the expected input and path`() {
    val cases = fixture("override-rejections.json").getValue("cases").jsonArray
    for (case in cases.map { it.jsonObject }) {
      val replay = replay(case.text("module"), case.text("platform"), inputs(case))
      val expected = case.getValue("expectedError").jsonObject
      assertEquals(
        case.text("name"),
        expected.getValue("index").jsonPrimitive.int to expected.text("path"),
        replay.error,
      )
    }
  }

  @Test
  fun `tracker holds real readings back in fake mode and shows the latest on return`() {
    val tracker = DeviceStatusTracker(json("""{"level":80,"state":"unplugged"}"""))
    assertNotNull(tracker.seed(DeviceStatusKind.BATTERY, json("""{"level":10}""")))
    tracker.mode(DeviceStatusMode.FAKE)
    assertNull(tracker.seed(DeviceStatusKind.BATTERY, json("""{"level":10}""")))
    tracker.update(json("""{"level":79,"state":"unplugged"}"""))
    assertEquals(json("""{"level":10,"state":"unplugged"}"""), tracker.state.value)
    assertNotNull(tracker.seed(DeviceStatusKind.BATTERY, json("""{"level":101}""")))
    assertEquals(json("""{"level":10,"state":"unplugged"}"""), tracker.state.value)
    tracker.mode(DeviceStatusMode.REAL)
    assertEquals(json("""{"level":79,"state":"unplugged"}"""), tracker.state.value)
  }

  @Test
  fun `tracker accepts the android-only ringer seed`() {
    val tracker = DeviceStatusTracker(json("""{"volume":40,"ringer":"normal"}"""))
    tracker.mode(DeviceStatusMode.FAKE)
    assertNull(tracker.seed(DeviceStatusKind.AUDIO, json("""{"ringer":"silent"}""")))
    assertEquals(json("""{"volume":40,"ringer":"silent"}"""), tracker.state.value)
  }

  private fun json(text: String) = Json.parseToJsonElement(text).jsonObject

  /**
   * The module's `<module>.changed` deliveries for [updates], whose first entry is the baseline.
   */
  private fun TestScope.events(
    module: String,
    updates: List<JsonObject>,
  ): List<JsonElement> {
    val origin = updates.first().getValue("timestampMs").jsonPrimitive.long
    val start = testScheduler.currentTime - origin
    val state = MutableStateFlow(updates.first().getValue("values").jsonObject)
    val source =
      object : PrototypeDeviceStatusSource {
        override val state = state

        override fun close() = Unit
      }
    val kind = DeviceStatusKind.entries.single { it.moduleName == module }
    val actual = mutableListOf<JsonElement>()
    val job = launch {
      PrototypeDeviceStatusModule(kind, source).events.collect { event ->
        actual += buildJsonObject {
          put("timestampMs", testScheduler.currentTime - start)
          put("values", event.data)
        }
      }
    }
    runCurrent()
    updates.drop(1).forEach { update ->
      val at = update.getValue("timestampMs").jsonPrimitive.long
      advanceTimeBy(at - (testScheduler.currentTime - start))
      runCurrent()
      state.value = update.getValue("values").jsonObject
      runCurrent()
    }
    advanceTimeBy(1_000)
    runCurrent()
    job.cancel()
    return actual
  }
}
