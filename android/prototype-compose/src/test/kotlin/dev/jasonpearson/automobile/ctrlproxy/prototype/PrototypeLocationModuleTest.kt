package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.*
import dev.jasonpearson.automobile.prototype.PrototypePlatform as RuntimePlatform
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeLocationModuleTest {
  private class FakeTimer(var now: Long = 0) {
    fun advance(ms: Long) {
      now += ms
    }
  }

  private val fix = LocationFix(44.12345, -93.12345, 5.0, 1234)

  private fun request(accuracy: String = "precise") =
    PlatformCall("c", "location.request", buildJsonObject { put("accuracy", accuracy) })

  private fun failure(result: PlatformCallResult) = (result as PlatformCallResult.Failure).error

  @Test
  fun `success writes only reported measurements and updates current`() = runTest {
    val source = FakePrototypeLocationSource().apply { fix = this@PrototypeLocationModuleTest.fix }
    val module = PrototypeLocationModule(source, scope = backgroundScope)
    val result = module.call(request()) as PlatformCallResult.Success
    assertEquals(fix.json(), result.value)
    assertEquals(
      setOf("latitude", "longitude", "accuracyM", "timestampMs", "approximate"),
      result.value.jsonObject.keys,
    )
    assertEquals(result.value, module.state.value["current"])
    assertEquals(JsonPrimitive(true), module.state.value["servicesEnabled"])
    module.close()
  }

  @Test
  fun `coarse grants and approximate requests succeed with coarse output`() = runTest {
    for (grant in listOf(PrototypeLocationGrant.APPROXIMATE, PrototypeLocationGrant.PRECISE)) {
      val source =
        FakePrototypeLocationSource().apply {
          fix =
            this@PrototypeLocationModuleTest.fix.copy(
              altitudeM = 42.0,
              bearingDeg = 90.0,
              speedMps = 2.0,
            )
          this.grant = grant
        }
      val module = PrototypeLocationModule(source, scope = backgroundScope)
      val accuracy = if (grant == PrototypeLocationGrant.PRECISE) "approximate" else "precise"
      val result = module.call(request(accuracy)) as PlatformCallResult.Success
      assertEquals(fix.coarse().json(), result.value)
      module.close()
    }
  }

  @Test
  fun `request forwards max age and uses approximate provider for a coarse grant`() = runTest {
    val source =
      FakePrototypeLocationSource().apply {
        grant = PrototypeLocationGrant.APPROXIMATE
        read = { accuracy, age ->
          assertEquals(PrototypeLocationAccuracy.APPROXIMATE, accuracy)
          assertEquals(60_000L, age)
          this@PrototypeLocationModuleTest.fix
        }
      }
    val module = PrototypeLocationModule(source, scope = backgroundScope)
    val args = buildJsonObject {
      put("accuracy", "precise")
      put("maxAgeMs", 60_000)
    }
    assertTrue(
      module.call(PlatformCall("c", "location.request", args)) is PlatformCallResult.Success,
    )
    module.close()
  }

  @Test
  fun `permission denied never asks the source and revoked permission is typed`() = runTest {
    val source =
      FakePrototypeLocationSource().apply {
        grant = PrototypeLocationGrant.NONE
        read = { _, _ -> error("must not read") }
      }
    val module = PrototypeLocationModule(source, scope = backgroundScope, warn = {})
    assertEquals(PlatformErrorCode.PERMISSION_DENIED, failure(module.call(request())).code)
    source.grant = PrototypeLocationGrant.PRECISE
    source.read = { _, _ -> throw SecurityException("revoked") }
    assertEquals(PlatformErrorCode.PERMISSION_DENIED, failure(module.call(request())).code)
    module.close()
  }

  @Test
  fun `disabled carries unavailable disabled and missing fix times out`() = runTest {
    val source = FakePrototypeLocationSource()
    val module = PrototypeLocationModule(source, scope = backgroundScope)
    source.servicesEnabled.value = false
    val error = failure(module.call(request()))
    assertEquals(PlatformErrorCode.UNAVAILABLE, error.code)
    assertEquals("disabled", error.reason)
    source.servicesEnabled.value = true
    assertEquals(PlatformErrorCode.TIMEOUT, failure(module.call(request())).code)
    module.close()
  }

  @Test
  fun `pending request ends unavailable disabled when services turn off`() = runTest {
    val source = FakePrototypeLocationSource().apply { read = { _, _ -> awaitCancellation() } }
    val module = PrototypeLocationModule(source, scope = backgroundScope)
    val result = async { module.call(request()) }
    runCurrent()
    assertFalse(result.isCompleted)
    source.servicesEnabled.value = false
    runCurrent()
    val error = failure(result.getCompleted())
    assertEquals(PlatformErrorCode.UNAVAILABLE, error.code)
    assertEquals("disabled", error.reason)
    // Completed by the toggle, not by a timeout: no virtual time passed.
    assertEquals(0L, currentTime)
    module.close()
  }

  @Test
  fun `permission granted while shown registers updates for the same config`() = runTest {
    val source = FakePrototypeLocationSource().apply { grant = PrototypeLocationGrant.NONE }
    // A frozen clock throttles every fix after the first within one subscription.
    val module = PrototypeLocationModule(source, { 0L }, backgroundScope)
    module.startUpdates(PrototypeLocationConfig())
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    module.startUpdates(PrototypeLocationConfig())
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    source.grant = PrototypeLocationGrant.PRECISE
    module.startUpdates(PrototypeLocationConfig())
    runCurrent()
    assertEquals(1, source.activeSubscriptions)
    val events = mutableListOf<PlatformEvent>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      module.events.collect { events += it }
    }
    source.readings.emit(fix)
    runCurrent()
    assertEquals(1, events.size)
    // An unchanged grant keeps the live subscription, so its throttle still drops the next fix.
    module.startUpdates(PrototypeLocationConfig())
    runCurrent()
    source.readings.emit(fix.copy(latitude = 45.0))
    runCurrent()
    assertEquals(1, events.size)
    assertEquals(1, source.activeSubscriptions)
    module.close()
  }

  @Test
  fun `a granted request re-registers updates that started without permission`() = runTest {
    val source =
      FakePrototypeLocationSource().apply {
        grant = PrototypeLocationGrant.NONE
        fix = this@PrototypeLocationModuleTest.fix
      }
    val module = PrototypeLocationModule(source, scope = backgroundScope)
    module.startUpdates(PrototypeLocationConfig())
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    source.grant = PrototypeLocationGrant.PRECISE
    assertTrue(module.call(request()) is PlatformCallResult.Success)
    runCurrent()
    assertEquals(1, source.activeSubscriptions)
    module.close()
  }

  @Test
  fun `fix ranges match the reference reducer and optional values remain optional`() = runTest {
    val source = FakePrototypeLocationSource()
    val module = PrototypeLocationModule(source, scope = backgroundScope)
    val invalid =
      listOf(
        fix.copy(latitude = 91.0),
        fix.copy(longitude = -181.0),
        fix.copy(accuracyM = Double.NaN),
        fix.copy(accuracyM = -1.0),
        fix.copy(timestampMs = -1),
        fix.copy(timestampMs = 9_007_199_254_740_992L),
        fix.copy(altitudeM = -20_001.0),
        fix.copy(speedMps = 1001.0),
        fix.copy(bearingDeg = 361.0),
      )
    for (value in invalid) {
      source.fix = value
      assertEquals(PlatformErrorCode.PLATFORM_ERROR, failure(module.call(request())).code)
    }
    source.fix =
      fix.copy(
        latitude = -90.0,
        longitude = 180.0,
        altitudeM = -20_000.0,
        speedMps = 1000.0,
        bearingDeg = 360.0,
      )
    assertTrue(module.call(request()) is PlatformCallResult.Success)
    module.close()
  }

  @Test
  fun `updates throttle and filter distance from last delivered fix and carry only summary`() =
    runTest {
      val timer = FakeTimer()
      val source = FakePrototypeLocationSource()
      val module = PrototypeLocationModule(source, { timer.now }, backgroundScope)
      val events = mutableListOf<PlatformEvent>()
      backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        module.events.collect { events += it }
      }
      module.startUpdates(PrototypeLocationConfig(minDistanceM = 100.0))
      runCurrent()
      source.readings.emit(fix)
      runCurrent()
      timer.advance(500)
      source.readings.emit(fix.copy(latitude = 45.0))
      runCurrent()
      timer.advance(500)
      source.readings.emit(fix.copy(latitude = fix.latitude + 0.00001))
      runCurrent()
      assertEquals(1, events.size)
      source.readings.emit(fix.copy(latitude = 45.0))
      runCurrent()
      assertEquals(2, events.size)
      assertEquals(
        buildJsonObject {
          put("accuracyM", 5.0)
          put("approximate", false)
        },
        events.last().data,
      )
      module.stopUpdates()
      runCurrent()
      assertEquals(0, source.activeSubscriptions)
      module.startUpdates(PrototypeLocationConfig())
      runCurrent()
      assertEquals(1, source.activeSubscriptions)
      source.servicesEnabled.value = false
      runCurrent()
      assertEquals(0, source.activeSubscriptions)
      source.servicesEnabled.value = true
      runCurrent()
      assertEquals(1, source.activeSubscriptions)
      module.close()
      runCurrent()
      assertEquals(0, source.activeSubscriptions)
      assertTrue(source.closed)
    }

  private fun fixture(): PrototypeSpec {
    val file =
      generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
        .map { File(it, "test/fixtures/prototype-spec/valid/platform-location.json") }
        .first { it.isFile }
    val validated = PrototypeSpecValidator.validate(file.readText())
    return (validated as PrototypeSpecValidation.Success).spec
  }

  private fun TestScope.runtime(
    source: FakePrototypeLocationSource,
    spec: PrototypeSpec = fixture(),
    start: Boolean = true,
  ): PrototypeRuntime =
    PrototypeRuntime(
        spec,
        sink = {},
        nextSequence = { 1L },
        monotonicMs = { testScheduler.currentTime },
        warn = {},
        requestScope = backgroundScope,
        clock = { testScheduler.currentTime },
        platform =
          RuntimePlatform(
            listOf(PrototypeLocationModule(source, { testScheduler.currentTime }, backgroundScope)),
          ),
      )
      .also { if (start) it.startPlatformModules() }

  private suspend fun PrototypeRuntime.request(timeout: Int = 100) {
    handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypePlatformAction(
            "location.request",
            emptyMap(),
            timeoutMs = timeout,
            into = "/data/here",
            statusKey = "locStatus",
          ),
        ),
      ),
    )
  }

  @Test
  fun `shared location corpus validates and runtime writes exact success and disabled metadata`() =
    runTest {
      val source =
        FakePrototypeLocationSource().apply { fix = this@PrototypeLocationModuleTest.fix }
      val runtime = runtime(source)
      runtime.request()
      runCurrent()
      assertEquals(fix.json(), runtime.current.spec.data?.get("here"))
      assertEquals(
        buildJsonObject {
          put("durationMs", 0)
          put("approximate", false)
        },
        runtime.current.spec.data?.get("here__meta"),
      )
      source.servicesEnabled.value = false
      runtime.request()
      runCurrent()
      val meta = runtime.current.spec.data!!.getValue("here__meta").jsonObject
      assertEquals(setOf("durationMs", "error"), meta.keys)
      assertEquals(JsonPrimitive("disabled"), meta.getValue("error").jsonObject["reason"])
      assertEquals(fix.json(), runtime.current.spec.data?.get("here"))
      runtime.close()
    }

  @Test
  fun `runtime preserves the last fix when a reported optional field is out of range`() = runTest {
    val source =
      FakePrototypeLocationSource().apply {
        fix = this@PrototypeLocationModuleTest.fix.copy(approximate = true)
      }
    val runtime = runtime(source)
    runtime.request()
    runCurrent()
    val previous = runtime.current.spec.data!!.getValue("here")
    assertEquals(fix.coarse().json(), previous)
    assertEquals(
      JsonPrimitive(true),
      runtime.current.spec.data!!.getValue("here__meta").jsonObject["approximate"],
    )
    source.fix = fix.copy(speedMps = 1001.0)
    runtime.request()
    runCurrent()
    assertEquals(previous, runtime.current.spec.data?.get("here"))
    val meta = runtime.current.spec.data!!.getValue("here__meta").jsonObject
    assertEquals(setOf("durationMs", "error"), meta.keys)
    assertEquals(
      JsonPrimitive("platform_error"),
      meta.getValue("error").jsonObject["code"],
    )
    assertFalse(meta.getValue("error").jsonObject.containsKey("reason"))
    assertEquals(PrototypeScalar.Text("error"), runtime.current.state["locStatus"])
    runtime.close()
  }

  @Test
  fun `dispatcher timeout cancels pending source with virtual time`() = runTest {
    var cancelled = false
    val source =
      FakePrototypeLocationSource().apply {
        read = { _, _ ->
          try {
            awaitCancellation()
          } finally {
            cancelled = true
          }
        }
      }
    val runtime = runtime(source)
    runtime.request()
    runCurrent()
    advanceTimeBy(101)
    runCurrent()
    assertTrue(cancelled)
    val meta = runtime.current.spec.data!!.getValue("here__meta").jsonObject
    assertEquals(JsonPrimitive("timeout"), meta.getValue("error").jsonObject["code"])
    assertEquals(JsonObject(emptyMap()), runtime.current.spec.data?.get("here"))
    runtime.close()
  }

  @Test
  fun `runtime starts only for a location block stops on pause resumes and stops on dismissal`() =
    runTest {
      val source = FakePrototypeLocationSource()
      val runtime = runtime(source, fixture().copy(location = JsonObject(emptyMap())))
      runCurrent()
      assertEquals(1, source.activeSubscriptions)
      runtime.pauseTimers()
      runCurrent()
      assertEquals(0, source.activeSubscriptions)
      runtime.resumeTimers()
      runCurrent()
      assertEquals(1, source.activeSubscriptions)
      runtime.finishDismissal(PrototypeDismissReason.USER)
      runCurrent()
      assertEquals(0, source.activeSubscriptions)
      runtime.resumeTimers()
      runCurrent()
      assertEquals(0, source.activeSubscriptions)
      runtime.close()
      val withoutBlock = runtime(source)
      runCurrent()
      assertEquals(0, source.activeSubscriptions)
      withoutBlock.close()
    }

  @Test
  fun `initially blocked show starts no updates until foregrounded`() = runTest {
    val source = FakePrototypeLocationSource()
    val spec = fixture().copy(location = JsonObject(emptyMap()))
    val runtime = runtime(source, spec, start = false)
    runtime.pauseTimers()
    runtime.startPlatformModules()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
    runtime.resumeTimers()
    runCurrent()
    assertEquals(1, source.activeSubscriptions)
    runtime.close()
    runCurrent()
    assertEquals(0, source.activeSubscriptions)
  }

  @Test
  fun `surfaces own subscriptions and closing one leaves the source and other surface alive`() =
    runTest {
      val source = FakePrototypeLocationSource()
      val owner = PrototypeLocationModule(source, scope = backgroundScope)
      val first = owner.session(backgroundScope)
      val second = owner.session(backgroundScope)
      first.startUpdates(PrototypeLocationConfig())
      second.startUpdates(PrototypeLocationConfig())
      runCurrent()
      assertEquals(2, source.activeSubscriptions)
      first.detach()
      runCurrent()
      assertEquals(1, source.activeSubscriptions)
      assertFalse(source.closed)
      second.detach()
      runCurrent()
      assertEquals(0, source.activeSubscriptions)
      owner.close()
      assertTrue(source.closed)
    }

  @Test
  fun `fix is rolled back when its metadata cannot be written beside an array entry`() = runTest {
    val source = FakePrototypeLocationSource().apply { fix = this@PrototypeLocationModuleTest.fix }
    val original = JsonArray(listOf(JsonPrimitive("old")))
    val spec = fixture().copy(data = buildJsonObject { put("here", original) })
    val runtime = runtime(source, spec)
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypePlatformAction(
            "location.request",
            emptyMap(),
            into = "/data/here/0",
            statusKey = "locStatus",
          ),
        ),
      ),
    )
    runCurrent()
    assertEquals(original, runtime.current.spec.data?.get("here"))
    assertEquals(PrototypeScalar.Text("error"), runtime.current.state["locStatus"])
    runtime.close()
  }
}
