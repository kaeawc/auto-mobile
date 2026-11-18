package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.*
import dev.jasonpearson.automobile.prototype.PrototypePlatform as RuntimePlatform
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeSensorsModuleTest {
  private class FakeTimer(var now: Long = 0)

  private fun repoFile(path: String): File =
    generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
      .map { File(it, path) }.first { it.exists() }

  private fun fixture(name: String = "platform-sensors"): PrototypeSpec =
    (PrototypeSpecValidator.validate(repoFile("test/fixtures/prototype-spec/valid/$name.json").readText())
      as PrototypeSpecValidation.Success).spec

  private fun block(vararg sensors: PrototypeSensor, rateHz: Int = 10) = buildJsonObject {
    sensors.forEach { sensor ->
      put(sensor.blockKey, buildJsonObject {
        if (sensor == PrototypeSensor.ORIENTATION || sensor == PrototypeSensor.LIGHT) put("rateHz", rateHz)
      })
    }
  }

  private fun values(at: Long, vararg values: Pair<String, Double>) =
    PrototypeSensorSample.Values(at, values.toMap())

  private fun TestScope.runtime(source: FakePrototypeSensorSource, spec: PrototypeSpec = fixture(), start: Boolean = true) =
    PrototypeRuntime(
      spec, sink = {}, nextSequence = { 1L }, warn = {}, requestScope = backgroundScope,
      clock = { testScheduler.currentTime }, monotonicMs = { testScheduler.currentTime },
      platform = RuntimePlatform(listOf(PrototypeSensorsModule(source, backgroundScope))),
    ).also { if (start) it.startPlatformModules() }

  @Test
  fun `every shared stream produces exactly the reference writes and shakes`() = runTest {
    val files = repoFile("test/fixtures/prototype-sensors").listFiles()!!.filter { it.extension == "json" }.sorted()
    assertTrue(files.isNotEmpty())
    for (file in files) {
      val fixture = Json.parseToJsonElement(file.readText()).jsonObject
      val key = fixture["key"]?.jsonPrimitive?.content
      val sensor = when (key) {
        null -> PrototypeSensor.SHAKE
        "lightLux" -> PrototypeSensor.LIGHT
        else -> PrototypeSensor.ORIENTATION
      }
      val source = FakePrototypeSensorSource()
      val module = PrototypeSensorsModule(source, backgroundScope)
      val timer = FakeTimer()
      val writes = mutableListOf<JsonElement>()
      val shakes = mutableListOf<Long>()
      val stateJob = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        module.state.collect { state ->
          if (key != null && state[key] != null) writes += buildJsonObject {
            put("timestampMs", timer.now)
            put("value", state.getValue(key))
          }
        }
      }
      val eventJob = backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        module.events.collect {
          assertEquals(PlatformEvent("sensors.shake", JsonObject(emptyMap())), it)
          shakes += timer.now
        }
      }
      module.startSensors(block(sensor, rateHz = fixture["rateHz"]?.jsonPrimitive?.int ?: 1))
      runCurrent()
      for (element in fixture.getValue("samples").jsonArray) {
        val sample = element.jsonObject
        timer.now = sample.getValue("timestampMs").jsonPrimitive.long
        val raw = if (key == null) PrototypeSensorSample.Acceleration(timer.now,
          sample.getValue("x").jsonPrimitive.double, sample.getValue("y").jsonPrimitive.double,
          sample.getValue("z").jsonPrimitive.double)
        else values(timer.now, key to sample.getValue("value").jsonPrimitive.double)
        source.readings.getValue(sensor).emit(raw)
        runCurrent()
      }
      if (key == null) assertEquals(file.name, fixture.getValue("expectedShakes").jsonArray.map { it.jsonPrimitive.long }, shakes)
      else assertEquals(file.name, fixture.getValue("expectedWrites").jsonArray.toList(), writes)
      module.close()
      runCurrent()
      assertEquals(0, source.activeSubscriptions)
      stateJob.cancel()
      eventJob.cancel()
    }
  }

  @Test
  fun `rounding ties ranges nonfinite values and per key throttles match the reference`() = runTest {
    assertEquals(-1.0, roundPrototypeSensorValue("rollDeg", -1.5), 0.0)
    assertEquals(359.0, roundPrototypeSensorValue("headingDeg", -1.5), 0.0)
    assertEquals(0.0, roundPrototypeSensorValue("lightLux", -9.0), 0.0)
    val source = FakePrototypeSensorSource()
    val module = PrototypeSensorsModule(source, backgroundScope)
    module.startSensors(block(PrototypeSensor.ORIENTATION))
    source.readings.getValue(PrototypeSensor.ORIENTATION).emit(values(0, "pitchDeg" to 1.0))
    source.readings.getValue(PrototypeSensor.ORIENTATION).emit(values(50, "pitchDeg" to 2.0, "rollDeg" to -1.5))
    source.readings.getValue(PrototypeSensor.ORIENTATION).emit(values(100, "pitchDeg" to 2.0, "rollDeg" to Double.NaN))
    runCurrent()
    assertEquals(JsonPrimitive(2), module.state.value["pitchDeg"])
    assertEquals(JsonPrimitive(-1), module.state.value["rollDeg"])
    module.close()
  }

  @Test
  fun `listens only to declared present sensors and rereads steps permission at start`() = runTest {
    val source = FakePrototypeSensorSource().apply {
      present.remove(PrototypeSensor.LIGHT)
      stepsGranted = false
    }
    val module = PrototypeSensorsModule(source, backgroundScope)
    val config = block(PrototypeSensor.STEPS, PrototypeSensor.LIGHT, PrototypeSensor.PROXIMITY)
    module.startSensors(config)
    runCurrent()
    assertEquals(listOf(PrototypeSensor.PROXIMITY to 1), source.subscriptions)
    assertTrue(module.state.value.isEmpty())
    source.stepsGranted = true
    module.startSensors(config)
    runCurrent()
    assertEquals(2, source.activeSubscriptions)
    source.readings.getValue(PrototypeSensor.STEPS).emit(values(0, "steps" to 1234.0))
    source.readings.getValue(PrototypeSensor.STEPS).emit(values(1000, "steps" to 1239.0, "lightLux" to 5.0))
    source.readings.getValue(PrototypeSensor.PROXIMITY).emit(PrototypeSensorSample.Proximity(0, true))
    runCurrent()
    assertEquals(JsonPrimitive(5), module.state.value["steps"])
    assertEquals(JsonPrimitive(true), module.state.value["proximityNear"])
    assertEquals(setOf("steps", "proximityNear"), module.state.value.keys)
    source.stepsGranted = false
    module.startSensors(config)
    runCurrent()
    assertFalse("steps" in module.state.value)
    assertEquals(1, source.activeSubscriptions)
    module.close()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    assertTrue(source.closed)
  }

  @Test
  fun `shake cooldown reaches platform on handler exactly once per window`() = runTest {
    val source = FakePrototypeSensorSource()
    val runtime = runtime(source, fixture("sensors-block-minimal"))
    runCurrent()
    for (at in listOf(0L, 999L, 1000L, 1100L)) {
      source.readings.getValue(PrototypeSensor.SHAKE).emit(PrototypeSensorSample.Acceleration(at, 30.0, 0.0, 0.0))
      runCurrent()
    }
    assertEquals(PrototypeScalar.Numeric(2.0), runtime.current.state["shakes"])
    runtime.close()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
  }

  @Test
  fun `runtime stops on pause removal cancellation and close and restarts only in foreground`() = runTest {
    val source = FakePrototypeSensorSource()
    val spec = fixture()
    val runtime = runtime(source, start = false)
    runtime.pauseTimers()
    runtime.startPlatformModules()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    runtime.resumeTimers()
    runCurrent()
    assertEquals(5, source.activeSubscriptions)
    runtime.pauseTimers()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    runtime.resumeTimers()
    runCurrent()
    runtime.replace(spec.copy(sensors = null))
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    runtime.replace(spec)
    runCurrent()
    assertEquals(5, source.activeSubscriptions)
    runtime.cancelPlatformCalls()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    runtime.resumeTimers()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    runtime.startPlatformModules()
    runCurrent()
    assertEquals(5, source.activeSubscriptions)
    runtime.close()
    runtime.resumeTimers()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    assertFalse(source.closed)
  }

  @Test
  fun `session teardown leaves sibling alive and resets steps for a new subscription`() = runTest {
    val source = FakePrototypeSensorSource()
    val owner = PrototypeSensorsModule(source, backgroundScope)
    val first = owner.session(backgroundScope)
    val second = owner.session(backgroundScope)
    val config = block(PrototypeSensor.STEPS)
    first.startSensors(config)
    second.startSensors(config)
    runCurrent()
    assertEquals(2, source.activeSubscriptions)
    first.detach()
    runCurrent()
    assertEquals(1, source.activeSubscriptions)
    assertFalse(source.closed)
    second.startSensors(config)
    runCurrent()
    assertEquals(1, source.activeSubscriptions)
    source.readings.getValue(PrototypeSensor.STEPS).emit(values(0, "steps" to 50.0))
    source.readings.getValue(PrototypeSensor.STEPS).emit(values(1000, "steps" to 52.0))
    assertEquals(JsonPrimitive(2), second.state.value["steps"])
    second.stopSensors()
    runCurrent()
    second.startSensors(config)
    source.readings.getValue(PrototypeSensor.STEPS).emit(values(2000, "steps" to 60.0))
    assertEquals(JsonPrimitive(0), second.state.value["steps"])
    second.detach()
    owner.close()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    assertTrue(source.closed)
  }

  @Test
  fun `sensors never accepts calls`() = runTest {
    val module = PrototypeSensorsModule(FakePrototypeSensorSource(), backgroundScope)
    val failure = module.call(PlatformCall("c", "sensors.request", JsonObject(emptyMap())))
    assertEquals(PlatformErrorCode.UNSUPPORTED, failure.error.code)
    module.close()
  }
}
