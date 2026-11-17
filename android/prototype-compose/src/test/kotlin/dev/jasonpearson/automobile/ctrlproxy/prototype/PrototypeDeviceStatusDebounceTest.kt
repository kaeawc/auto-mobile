package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.fixtureFile
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeDeviceStatusDebounceTest(private val file: String) {
  @Test
  fun `debounce replays shared fixture verbatim with virtual time`() = runTest {
    val fixture =
      Json.parseToJsonElement(fixtureFile("prototype-device-status/$file").readText()).jsonObject
    val updates = fixture.getValue("updates").jsonArray.map { it.jsonObject }
    val tracker = DeviceStatusTracker(updates.first().getValue("values").jsonObject)
    val source =
      object : PrototypeDeviceStatusSource {
        override val state = tracker.state

        override fun close() = Unit
      }
    val kind =
      DeviceStatusKind.entries.single {
        it.moduleName == fixture.getValue("module").jsonPrimitive.content
      }
    val module = PrototypeDeviceStatusModule(kind, source)
    val actual = mutableListOf<JsonObject>()
    val job = launch {
      module.events.collect { event ->
        assertEquals("${kind.moduleName}.changed", event.name)
        actual += buildJsonObject {
          put("timestampMs", testScheduler.currentTime)
          put("values", event.data)
        }
      }
    }
    runCurrent()
    updates.drop(1).forEach { update ->
      advanceTimeBy(update.getValue("timestampMs").jsonPrimitive.long - testScheduler.currentTime)
      // A timer due at this timestamp fires before the next reading applies.
      runCurrent()
      tracker.update(update.getValue("values").jsonObject)
      runCurrent()
    }
    advanceTimeBy(1_000)
    runCurrent()
    assertEquals(fixture.getValue("expectedEvents").jsonArray.toList(), actual)
    job.cancel()
  }

  companion object {
    @JvmStatic
    @Parameterized.Parameters(name = "{0}")
    fun fixtures(): List<Array<String>> =
      fixtureFile("prototype-device-status")
        .listFiles()!!
        .filter { it.name.startsWith("debounce-") }
        .sortedBy { it.name }
        .map { arrayOf(it.name) }
  }
}
