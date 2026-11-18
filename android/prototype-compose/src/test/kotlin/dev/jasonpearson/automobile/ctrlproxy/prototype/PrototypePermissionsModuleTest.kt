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
class PrototypePermissionsModuleTest {
  companion object {
    private lateinit var spec: PrototypeSpec

    @BeforeClass
    @JvmStatic
    fun warm() {
      val file =
        generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
          .map { File(it, "test/fixtures/prototype-spec/valid/platform-permissions-request.json") }
          .first { it.isFile }
      val parsed =
        (PrototypeSpecValidator.validate(file.readText()) as PrototypeSpecValidation.Success).spec
      spec =
        parsed.copy(
          requires =
            parsed.requires!!.copy(
              permissions =
                parsed.requires!!.permissions.orEmpty() +
                  PrototypePermissionRequirement("notifications", "Notify me"),
            ),
          data =
            buildJsonObject { put("requested", JsonArray(listOf(JsonPrimitive("microphone")))) },
        )
      runTest {
        val source = FakePrototypePermissionsSource()
        val runtime = with(PrototypePermissionsModuleTest()) { runtime(source) }
        source.changes.emit(PrototypePermissionState.GRANTED)
        runCurrent()
        runtime.handle(
          PrototypeInteraction.Tap(
            listOf(
              PrototypePlatformAction(
                "permissions.request",
                mapOf("names" to buildJsonObject { put("data", "/data/requested") }),
                statusKey = "requestStatus",
              ),
            ),
          ),
        )
        runCurrent()
        runtime.close()
        val module = PrototypePermissionsModule(FakePrototypePermissionsSource(), backgroundScope)
        module.call(call())
        module.close()
      }
    }

    private fun call(vararg names: String = arrayOf("notifications")) =
      PlatformCall(
        "request",
        "permissions.request",
        buildJsonObject { put("names", JsonArray(names.map(::JsonPrimitive))) },
      )
  }

  @Test
  fun `supported states are per-name results and published state`() = runTest {
    for (state in
      listOf(
        PrototypePermissionState.GRANTED,
        PrototypePermissionState.DENIED,
        PrototypePermissionState.BLOCKED,
        PrototypePermissionState.NOT_DETERMINED,
        PrototypePermissionState.UNAVAILABLE,
      )) {
      val source = FakePrototypePermissionsSource().apply { current = state }
      val module = PrototypePermissionsModule(source, backgroundScope)
      assertEquals(
        PlatformCallResult.Success(
          buildJsonObject { put("results", buildJsonObject { put("notifications", state.wire) }) },
        ),
        module.call(call()),
      )
      assertEquals(JsonPrimitive(state.wire), module.state.value["notifications"])
      module.close()
      assertTrue(source.closed)
    }
  }

  @Test
  fun `other canonical names report unavailable without source access`() = runTest {
    val source = FakePrototypePermissionsSource()
    val module = PrototypePermissionsModule(source, backgroundScope)
    val names = PrototypePlatformPermissions.names.filter { it != "notifications" }
    val result = module.call(call(*names.toTypedArray())) as PlatformCallResult.Success
    val results = result.value.jsonObject.getValue("results").jsonObject
    assertEquals(names.toSet(), results.keys)
    assertTrue(results.values.all { it == JsonPrimitive("unavailable") })
    assertEquals(0, source.requests)
    assertTrue(names.all { module.state.value[it] == JsonPrimitive("unavailable") })
    module.close()
  }

  @Test
  fun `mixed request returns results for supported and unsupported names`() = runTest {
    val module =
      PrototypePermissionsModule(
        FakePrototypePermissionsSource().apply { current = PrototypePermissionState.GRANTED },
        backgroundScope,
      )
    val result = module.call(call("notifications", "camera")) as PlatformCallResult.Success
    assertEquals(
      Json.parseToJsonElement("""{"results":{"notifications":"granted","camera":"unavailable"}}"""),
      result.value,
    )
    module.close()
  }

  @Test
  fun `provisional options are accepted and ignored`() = runTest {
    for (options in listOf("{}", """{"provisional":false}""", """{"provisional":true}""")) {
      val source =
        FakePrototypePermissionsSource().apply { current = PrototypePermissionState.GRANTED }
      val module = PrototypePermissionsModule(source, backgroundScope)
      val args = JsonObject(call().args + ("options" to Json.parseToJsonElement(options)))
      val result = module.call(call().copy(args = args)) as PlatformCallResult.Success
      assertEquals(
        Json.parseToJsonElement("""{"results":{"notifications":"granted"}}"""),
        result.value,
      )
      assertEquals(1, source.requests)
      module.close()
    }
  }

  @Test
  fun `invalid args and unknown calls fail before reading source`() = runTest {
    val source = FakePrototypePermissionsSource()
    val module = PrototypePermissionsModule(source, backgroundScope)
    for (args in
      listOf(
        "{}",
        """{"names":[]}""",
        """{"names":["bad"]}""",
        """{"names":["notifications","notifications"]}""",
        """{"names":"notifications"}""",
        """{"names":[1]}""",
        """{"names":["notifications"],"extra":true}""",
        """{"names":["notifications"],"options":true}""",
        """{"names":["notifications"],"options":null}""",
        """{"names":["notifications"],"options":[]}""",
        """{"names":["notifications"],"options":{"provisional":"true"}}""",
        """{"names":["notifications"],"options":{"unknown":true}}""",
      )) {
      val result =
        module.call(call().copy(args = Json.parseToJsonElement(args).jsonObject))
          as PlatformCallResult.Failure
      assertEquals(args, PlatformErrorCode.INVALID_ARGS, result.error.code)
    }
    assertEquals(
      PlatformErrorCode.UNSUPPORTED,
      (module.call(call().copy(call = "permissions.other")) as PlatformCallResult.Failure)
        .error
        .code,
    )
    assertEquals(0, source.requests)
    module.close()
  }

  @Test
  fun `second call is refused and close cancels a pending request cleanly`() = runTest {
    val source = FakePrototypePermissionsSource().apply { outcomes = flow { awaitCancellation() } }
    val module = PrototypePermissionsModule(source, backgroundScope)
    val first = async { module.call(call()) }
    runCurrent()
    assertEquals(
      PlatformErrorCode.TOO_MANY_IN_FLIGHT,
      (module.call(call()) as PlatformCallResult.Failure).error.code,
    )
    module.close()
    assertEquals(
      PlatformErrorCode.CANCELLED,
      (first.await() as PlatformCallResult.Failure).error.code,
    )
    assertTrue(source.closed)
    assertEquals(
      PlatformErrorCode.UNAVAILABLE,
      (module.call(call()) as PlatformCallResult.Failure).error.code,
    )
  }

  @Test
  fun `caller cancellation releases ownership for the next call`() = runTest {
    val source = FakePrototypePermissionsSource().apply { outcomes = flow { awaitCancellation() } }
    val module = PrototypePermissionsModule(source, backgroundScope)
    val pending = async { module.call(call()) }
    runCurrent()
    pending.cancelAndJoin()
    source.outcomes = flowOf(PrototypePermissionOutcome.Status(PrototypePermissionState.GRANTED))
    assertTrue(module.call(call()) is PlatformCallResult.Success)
    module.close()
  }

  @Test
  fun `resume changes publish state and one event only when authorization differs`() = runTest {
    val source = FakePrototypePermissionsSource()
    val module = PrototypePermissionsModule(source, backgroundScope)
    val events = mutableListOf<PlatformEvent>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) { module.events.toList(events) }
    assertEquals(JsonPrimitive("notDetermined"), module.state.value["notifications"])
    for (state in
      listOf(
        PrototypePermissionState.GRANTED,
        PrototypePermissionState.GRANTED,
        PrototypePermissionState.BLOCKED,
      )) source.changes.emit(state)
    assertEquals(JsonPrimitive("blocked"), module.state.value["notifications"])
    assertEquals(
      listOf("granted", "blocked"),
      events.map { it.data.getValue("state").jsonPrimitive.content },
    )
    assertTrue(
      events.all {
        it.name == "permissions.changed" && it.data["name"] == JsonPrimitive("notifications")
      },
    )
    module.close()
    runCurrent()
    assertEquals(0, source.changes.subscriptionCount.value)
  }

  @Test
  fun `runtime publishes permissions state and resume event and detaches without closing shared source`() =
    runTest {
      val source = FakePrototypePermissionsSource()
      val runtime = runtime(source)
      runCurrent()
      assertEquals(
        JsonPrimitive("notDetermined"),
        runtime.current.platformState.getValue("permissions").jsonObject["notifications"],
      )
      source.changes.emit(PrototypePermissionState.GRANTED)
      runCurrent()
      assertEquals(
        JsonPrimitive("granted"),
        runtime.current.platformState.getValue("permissions").jsonObject["notifications"],
      )
      assertEquals(PrototypeScalar.Numeric(1.0), runtime.current.state["changes"])
      assertFalse("notifications" in runtime.current.platformState)
      runtime.close()
      runCurrent()
      assertFalse(source.closed)
      assertEquals(0, source.changes.subscriptionCount.value)
    }

  @Test
  fun `permission prompt stays loading beyond platform deadlines and a late grant succeeds`() =
    runTest {
      for (timeout in listOf(null, 1)) {
        val answer = CompletableDeferred<PrototypePermissionOutcome>()
        val source =
          FakePrototypePermissionsSource().apply { outcomes = flow { emit(answer.await()) } }
        val runtime = runtime(source)
        runtime.handle(
          PrototypeInteraction.Tap(
            listOf(
              PrototypePlatformAction(
                "permissions.request",
                mapOf(
                  "names" to
                    buildJsonObject {
                      put("value", JsonArray(listOf(JsonPrimitive("notifications"))))
                    },
                ),
                statusKey = "requestStatus",
                timeoutMs = timeout,
              ),
            ),
          ),
        )
        runCurrent()
        advanceTimeBy(300_001)
        runCurrent()
        assertEquals(PrototypeScalar.Text("loading"), runtime.current.state["requestStatus"])
        assertEquals(1, source.requests)
        answer.complete(PrototypePermissionOutcome.Status(PrototypePermissionState.GRANTED))
        runCurrent()
        assertEquals(PrototypeScalar.Text("success"), runtime.current.state["requestStatus"])
        assertEquals(
          JsonPrimitive("granted"),
          runtime.current.platformState.getValue("permissions").jsonObject["notifications"],
        )
        runtime.close()
      }
    }

  @Test
  fun `long pending permission prompt is still cancelled on runtime replacement`() = runTest {
    val source = FakePrototypePermissionsSource().apply { outcomes = flow { awaitCancellation() } }
    val runtime = runtime(source)
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypePlatformAction(
            "permissions.request",
            mapOf(
              "names" to
                buildJsonObject { put("value", JsonArray(listOf(JsonPrimitive("notifications")))) },
            ),
            statusKey = "requestStatus",
          ),
        ),
      ),
    )
    runCurrent()
    advanceTimeBy(30_000)
    runCurrent()
    assertEquals(PrototypeScalar.Text("loading"), runtime.current.state["requestStatus"])
    runtime.cancelPlatformCalls()
    runCurrent()
    assertEquals(PrototypeScalar.Text("error"), runtime.current.state["requestStatus"])
    runtime.close()
  }

  @Test
  fun `runtime refuses undeclared bound permission before source access`() = runTest {
    val source = FakePrototypePermissionsSource()
    val runtime = runtime(source)
    runtime.handle(
      PrototypeInteraction.Tap(
        listOf(
          PrototypePlatformAction(
            "permissions.request",
            mapOf(
              "names" to buildJsonObject { put("data", "/data/requested") },
            ),
            statusKey = "requestStatus",
          ),
        ),
      ),
    )
    runCurrent()
    assertEquals(0, source.requests)
    assertEquals(PrototypeScalar.Text("error"), runtime.current.state["requestStatus"])
    runtime.close()
  }

  private fun TestScope.runtime(source: PrototypePermissionsSource) =
    PrototypeRuntime(
        spec,
        sink = {},
        nextSequence = { 1L },
        warn = {},
        requestScope = backgroundScope,
        clock = { testScheduler.currentTime },
        monotonicMs = { testScheduler.currentTime },
        platform = RuntimePlatform(listOf(PrototypePermissionsModule(source, backgroundScope))),
      )
      .also { it.startPlatformModules() }
}
