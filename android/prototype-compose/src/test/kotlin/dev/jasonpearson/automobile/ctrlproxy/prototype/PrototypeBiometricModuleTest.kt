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
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeBiometricModuleTest {
  companion object {
    private lateinit var spec: PrototypeSpec

    @JvmStatic
    @BeforeClass
    fun warm() {
      val file =
        generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/valid/platform-biometric.json") }
          .first { it.isFile }
      spec =
        (PrototypeSpecValidator.validate(file.readText()) as PrototypeSpecValidation.Success).spec
      with(PrototypeBiometricModuleTest()) {
        runTest {
          val runtime = runtime(FakePrototypeBiometricSource(), mutableListOf())
          runtime.handle(
            PrototypeInteraction.Tap(
              listOf(
                PrototypePlatformAction(
                  "biometric.authenticate",
                  mapOf("title" to buildJsonObject { put("value", "Warm") }),
                  statusKey = "authStatus",
                ),
              ),
            ),
          )
          runCurrent()
          runtime.close()
        }
      }
    }
  }

  private val call =
    PlatformCall("c", "biometric.authenticate", buildJsonObject { put("title", "Unlock") })

  @Test
  fun `all terminal outcomes produce typed data-free results`() = runTest {
    val source = FakePrototypeBiometricSource()
    val module = PrototypeBiometricModule(source)
    val failures =
      mapOf(
        PrototypeBiometricOutcome.CANCELLED to (PlatformErrorCode.CANCELLED to null),
        PrototypeBiometricOutcome.NOT_ENROLLED to (PlatformErrorCode.UNAVAILABLE to "not_enrolled"),
        PrototypeBiometricOutcome.NO_HARDWARE to (PlatformErrorCode.UNAVAILABLE to "no_hardware"),
        PrototypeBiometricOutcome.LOCKOUT to (PlatformErrorCode.UNAVAILABLE to "lockout"),
        PrototypeBiometricOutcome.UNAVAILABLE to (PlatformErrorCode.UNAVAILABLE to null),
        PrototypeBiometricOutcome.BUSY to (PlatformErrorCode.TOO_MANY_IN_FLIGHT to null),
        PrototypeBiometricOutcome.ERROR to (PlatformErrorCode.PLATFORM_ERROR to null),
      )
    assertEquals(PlatformCallResult.Success(JsonObject(emptyMap())), module.call(call))
    failures.forEach { (outcome, expected) ->
      source.outcomes = flowOf(outcome)
      val error = (module.call(call) as PlatformCallResult.Failure).error
      assertEquals(expected.first, error.code)
      assertEquals(expected.second, error.reason)
    }
    assertEquals(PrototypeBiometricRequest("Unlock"), source.requests.first())
    assertTrue(module.state.value.isEmpty())
    module.close()
    assertTrue(source.closed)
  }

  @Test
  fun `arguments use the existing contract before source access`() = runTest {
    val source = FakePrototypeBiometricSource()
    val module = PrototypeBiometricModule(source)
    for (args in
      listOf(
        "{}",
        "{\"title\":\"\"}",
        "{\"title\":\"${"x".repeat(65)}\"}",
        "{\"title\":\"Unlock\",\"subtitle\":\"${"x".repeat(129)}\"}",
        "{\"title\":\"Unlock\",\"allowDeviceCredential\":1}",
      )) {
      val error =
        (module.call(call.copy(args = Json.parseToJsonElement(args).jsonObject))
            as PlatformCallResult.Failure)
          .error
      assertEquals(PlatformErrorCode.INVALID_ARGS, error.code)
    }
    assertTrue(source.requests.isEmpty())
    assertEquals(
      PlatformErrorCode.UNSUPPORTED,
      (module.call(call.copy(call = "biometric.unknown")) as PlatformCallResult.Failure).error.code,
    )
  }

  @Test
  fun `dispatcher keeps failed attempt pending and reports result timing without platform state`() =
    runTest {
      val outcomes = MutableSharedFlow<PrototypeBiometricOutcome>()
      val source = FakePrototypeBiometricSource().apply { this.outcomes = outcomes }
      val events = mutableListOf<PrototypeEvent>()
      val runtime = runtime(source, events)
      runtime.handle(
        PrototypeInteraction.Tap(
          (spec.root as PrototypeColumnNode)
            .children
            .filterIsInstance<PrototypeButtonNode>()
            .single()
            .onTap!!,
        ),
      )
      runCurrent()
      assertEquals(PrototypeScalar.Text("loading"), runtime.current.state["authStatus"])
      outcomes.emit(PrototypeBiometricOutcome.ATTEMPT_FAILED)
      runCurrent()
      assertEquals(PrototypeScalar.Numeric(1.0), runtime.current.state["failures"])
      assertEquals(PrototypeScalar.Text("loading"), runtime.current.state["authStatus"])
      advanceTimeBy(25)
      outcomes.emit(PrototypeBiometricOutcome.SUCCESS)
      runCurrent()
      assertEquals(PrototypeScalar.Text("success"), runtime.current.state["authStatus"])
      assertEquals(PrototypeScalar.BooleanValue(true), runtime.current.state["unlocked"])
      assertFalse("biometric" in runtime.current.platformState)
      val completion = events.single { it.name == "prototype_platform" }
      assertEquals(JsonPrimitive(25), completion.payload!!.jsonObject["durationMs"])
      assertFalse(completion.payload.toString().contains("Confirm it's you"))
      assertEquals(
        PrototypeBiometricRequest("Unlock vault", "Confirm it's you"),
        source.requests.single(),
      )
      runtime.close()
    }

  @Test
  fun `dispatcher timeout cancels source and writes error status with virtual time`() = runTest {
    var cancelled = false
    val source =
      FakePrototypeBiometricSource().apply {
        outcomes = flow {
          try {
            awaitCancellation()
          } finally {
            cancelled = true
          }
        }
      }
    val events = mutableListOf<PrototypeEvent>()
    val runtime = runtime(source, events)
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypePlatformAction(
            "biometric.authenticate",
            mapOf("title" to buildJsonObject { put("value", "Unlock") }),
            timeoutMs = 100,
            statusKey = "authStatus",
          ),
        ),
      ),
    )
    runCurrent()
    advanceTimeBy(101)
    runCurrent()
    assertTrue(cancelled)
    assertEquals(PrototypeScalar.Text("error"), runtime.current.state["authStatus"])
    assertEquals(
      JsonPrimitive("timeout"),
      events
        .single { it.name == "prototype_platform" }
        .payload!!
        .jsonObject["error"]!!
        .jsonObject["code"],
    )
    runtime.close()
  }

  @Test
  fun `dispatcher preserves unavailable reasons and reports cancelled as an error`() = runTest {
    val cases =
      mapOf(
        PrototypeBiometricOutcome.NOT_ENROLLED to "not_enrolled",
        PrototypeBiometricOutcome.NO_HARDWARE to "no_hardware",
        PrototypeBiometricOutcome.LOCKOUT to "lockout",
        PrototypeBiometricOutcome.CANCELLED to null,
      )
    for ((outcome, reason) in cases) {
      val source = FakePrototypeBiometricSource().apply { outcomes = flowOf(outcome) }
      val events = mutableListOf<PrototypeEvent>()
      val runtime = runtime(source, events)
      runtime.handle(
        PrototypeInteraction.Tap(
          listOf(
            PrototypePlatformAction(
              "biometric.authenticate",
              mapOf("title" to buildJsonObject { put("value", "Unlock") }),
              into = "/data/result",
              statusKey = "authStatus",
            ),
          ),
        ),
      )
      runCurrent()
      assertEquals(PrototypeScalar.Text("error"), runtime.current.state["authStatus"])
      val error =
        events.single { it.name == "prototype_platform" }.payload!!.jsonObject["error"]!!.jsonObject
      assertEquals(JsonPrimitive(if (reason == null) "cancelled" else "unavailable"), error["code"])
      assertEquals(reason?.let(::JsonPrimitive), error["reason"])
      assertEquals(error, runtime.current.spec.data!!.getValue("result__meta").jsonObject["error"])
      runtime.close()
    }
  }

  @Test
  fun `dismissal cancels a pending call and sessions keep attempt events separate`() = runTest {
    var cancelled = false
    val source =
      FakePrototypeBiometricSource().apply {
        outcomes = flow {
          emit(PrototypeBiometricOutcome.ATTEMPT_FAILED)
          try {
            awaitCancellation()
          } finally {
            cancelled = true
          }
        }
      }
    val owner = PrototypeBiometricModule(source)
    val siblingEvents = mutableListOf<PlatformEvent>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      owner.session().events.collect { siblingEvents += it }
    }
    val runtime = runtime(source, mutableListOf())
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypePlatformAction(
            "biometric.authenticate",
            mapOf("title" to buildJsonObject { put("value", "Unlock") }),
            statusKey = "authStatus",
          ),
        ),
      ),
    )
    runCurrent()
    runtime.close()
    runCurrent()
    assertTrue(cancelled)
    assertTrue(siblingEvents.isEmpty())
    assertFalse(source.closed)
    owner.close()
    assertTrue(source.closed)
  }

  private fun TestScope.runtime(
    source: PrototypeBiometricSource,
    events: MutableList<PrototypeEvent>,
  ) =
    PrototypeRuntime(
        spec,
        sink = { events += it },
        nextSequence = { 1L },
        warn = {},
        requestScope = backgroundScope,
        clock = { testScheduler.currentTime },
        monotonicMs = { testScheduler.currentTime },
        platform = RuntimePlatform(listOf(PrototypeBiometricModule(source))),
      )
      .also { it.startPlatformModules() }
}
