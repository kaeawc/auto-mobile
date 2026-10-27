package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformEvent
import dev.jasonpearson.automobile.prototype.PrototypePlatform as Platform
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypePlatformRuntimeTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeSpecValidator.validate("{}")
      // Pay serializer and coroutine initialization outside each measured transition test.
      with(PrototypePlatformRuntimeTest()) {
        runTest {
          val module = FakePlatformModule()
          val subject =
            runtime(
              module,
              mutableListOf(),
              spec(
                mapOf(
                  "test.tick" to
                    listOf(
                      PrototypePlatformAction(
                        "test.echo",
                        mapOf("message" to obj("event" to JsonPrimitive("/count"))),
                        into = "/data/observed",
                      ),
                    ),
                ),
              ),
            )
          subject.tap(
            action(
              follow =
                listOf(
                  PrototypeSetDataAction("/data/observed", obj("data" to JsonPrimitive("/result"))),
                ),
            ),
          )
          runCurrent()
          module.state.value = obj("count" to JsonPrimitive(1))
          runCurrent()
          subject.renderModel()
          module.events.emit(PlatformEvent("test.tick", obj("count" to JsonPrimitive(1))))
          runCurrent()
          module.execute = { throw CancellationException("warm cancellation") }
          subject.tap(action())
          runCurrent()
          module.execute = { awaitCancellation() }
          subject.tap(action())
          runCurrent()
          subject.finishDismissal(PrototypeDismissReason.USER)
          runCurrent()
          val closing = runtime(module, mutableListOf())
          closing.tap(action())
          runCurrent()
          closing.close()
          runCurrent()
        }
      }
    }
  }

  private fun obj(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

  private fun spec(handlers: Map<String, List<PrototypeAction>> = emptyMap()) =
    PrototypeSpec(
      "platform",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      state = mapOf("status" to PrototypeScalar.Text("idle")),
      root = PrototypeTextNode(text = "{platform:/test/count}"),
      data = obj("result" to JsonPrimitive("old"), "observed" to JsonPrimitive("old")),
      requires = PrototypeRequires(platform = listOf("test")),
      platform = PrototypePlatformHandlers(handlers),
    )

  private fun action(
    delay: Int = 0,
    into: String? = "/data/result",
    follow: List<PrototypeAction>? = null,
  ) =
    PrototypePlatformAction(
      "test.echo",
      mapOf(
        "message" to obj("value" to JsonPrimitive("hello")),
        "delayMs" to obj("value" to JsonPrimitive(delay)),
      ),
      into = into,
      statusKey = "status",
      onSuccess = follow,
    )

  private fun TestScope.runtime(
    module: FakePlatformModule,
    events: MutableList<PrototypeEvent>,
    spec: PrototypeSpec = spec(),
    lock: Mutex = Mutex(),
    sink: suspend (PrototypeEvent) -> Unit = { events += it },
    inFlight: Int = PrototypePlatformDispatcher.MAX_IN_FLIGHT,
  ): PrototypeRuntime {
    var id = 0
    var seq = 0L
    return PrototypeRuntime(
        spec,
        sink = { sink(it) },
        clock = { testScheduler.currentTime },
        nextSequence = { ++seq },
        requestScope = backgroundScope,
        exclusively = { lock.withLock { it() } },
        newRequestId = { "call-${++id}" },
        platform = Platform(listOf(module)),
        platformLimiter = PrototypeRequestLimiter(inFlight),
        warn = { error(it) },
      )
      .also { it.startPlatformModules() }
  }

  private suspend fun PrototypeRuntime.tap(vararg actions: PrototypeAction) =
    handle(PrototypeInteraction.Tap(actions.toList()))

  private fun outcomes(events: List<PrototypeEvent>) = events.filter {
    it.name == PrototypePlatform.CALL_EVENT_NAME
  }

  @Test
  fun `completion writes result metadata status event and follow ups in order`() = runTest {
    val module = FakePlatformModule()
    val events = mutableListOf<PrototypeEvent>()
    lateinit var runtime: PrototypeRuntime
    val seen = mutableListOf<String>()
    runtime =
      runtime(
        module,
        events,
        sink = {
          events += it
          if (it.kind == PrototypeEventKind.CHANGE) seen += it.name.orEmpty()
          if (it.name == PrototypePlatform.CALL_EVENT_NAME) {
            assertEquals(JsonPrimitive("hello"), runtime.current.spec.data!!["result"])
            assertEquals(
              "success",
              runtime.current.spec.data!!["result__meta"]!!
                .jsonObject["outcome"]!!
                .jsonPrimitive
                .content,
            )
            assertEquals(PrototypeScalar.Text("success"), it.state["status"])
            assertEquals(JsonPrimitive("old"), runtime.current.spec.data!!["observed"])
            seen += "event"
          }
        },
      )
    module.execute = {
      delay(10)
      PlatformCallResult.Success(it.args.getValue("message"))
    }
    runtime.tap(
      action(
        follow =
          listOf(PrototypeSetDataAction("/data/observed", obj("data" to JsonPrimitive("/result")))),
      ),
    )
    assertEquals(PrototypeScalar.Text("loading"), runtime.current.state["status"])
    advanceTimeBy(10)
    runCurrent()
    assertEquals(JsonPrimitive("hello"), runtime.current.spec.data!!["observed"])
    val resultIndex = events.indexOfFirst { it.name == "/data/result" }
    val metaIndex = events.indexOfFirst { it.name == "/data/result__meta" }
    assertTrue(resultIndex >= 0 && metaIndex > resultIndex)
    assertEquals(
      10L,
      outcomes(events).single().payload!!.jsonObject["durationMs"]!!.jsonPrimitive.long,
    )
    runtime.close()
  }

  @Test
  fun `dismiss and close cancel once and late results cannot write`() = runTest {
    for (dismiss in listOf(false, true)) {
      val module = FakePlatformModule().apply { execute = { awaitCancellation() } }
      val events = mutableListOf<PrototypeEvent>()
      val runtime = runtime(module, events)
      runtime.tap(action())
      runCurrent()
      if (dismiss) runtime.finishDismissal(PrototypeDismissReason.USER) else runtime.close()
      runCurrent()
      assertEquals(
        "cancelled",
        outcomes(events)
          .single()
          .payload!!
          .jsonObject["error"]!!
          .jsonObject["code"]!!
          .jsonPrimitive
          .content,
      )
      assertEquals(JsonPrimitive("old"), runtime.current.spec.data!!["result"])
      if (dismiss) assertEquals(PrototypeEventKind.DISMISSED, events.last().kind)
      assertFalse(module.closed) // app owns modules shared by surfaces
    }
  }

  @Test
  fun `replacement cancellation is settled before old runtime closes`() = runTest {
    val module = FakePlatformModule().apply { execute = { awaitCancellation() } }
    val events = mutableListOf<PrototypeEvent>()
    val runtime = runtime(module, events)
    runtime.tap(action())
    runCurrent()
    runtime.cancelPlatformCalls()
    runtime.close()
    runCurrent()
    assertEquals(1, outcomes(events).size)
    assertEquals(
      "cancelled",
      outcomes(events)
        .single()
        .payload!!
        .jsonObject["error"]!!
        .jsonObject["code"]!!
        .jsonPrimitive
        .content,
    )
  }

  @Test
  fun `state streams rerender and handlers stay atomic versus tap`() = runTest {
    val module = FakePlatformModule()
    val events = mutableListOf<PrototypeEvent>()
    val lock = Mutex()
    val paused = CompletableDeferred<Unit>()
    val release = CompletableDeferred<Unit>()
    val runtime =
      runtime(
        module,
        events,
        spec(
          mapOf(
            "test.tick" to
              listOf(
                PrototypeSetDataAction("/data/observed", obj("value" to JsonPrimitive(9))),
                PrototypeEmitAction("handler"),
              ),
          ),
        ),
        lock,
        sink = {
          events += it
          if (it.name == "handler") {
            paused.complete(Unit)
            release.await()
          }
        },
      )
    runCurrent()
    module.state.value = obj("count" to JsonPrimitive(7))
    runCurrent()
    assertEquals("7", runtime.renderModel().root.text)
    backgroundScope.launch {
      module.events.emit(PlatformEvent("test.tick", obj("count" to JsonPrimitive(9))))
    }
    runCurrent()
    assertTrue(paused.isCompleted)
    val tap = backgroundScope.launch { lock.withLock { runtime.tap(PrototypeEmitAction("tap")) } }
    runCurrent()
    assertFalse(tap.isCompleted)
    assertEquals(JsonPrimitive(9), runtime.current.spec.data!!["observed"])
    release.complete(Unit)
    runCurrent()
    assertEquals(
      listOf("handler", PrototypePlatform.DELIVERED_EVENT_NAME, "tap"),
      events.filter { it.kind == PrototypeEventKind.EMIT }.map { it.name },
    )
    runtime.tap(
      PrototypePlatformAction(
        "test.echo",
        mapOf("message" to obj("event" to JsonPrimitive("/count"))),
      ),
    )
    assertEquals(
      "invalid_args",
      outcomes(events)
        .last()
        .payload!!
        .jsonObject["error"]!!
        .jsonObject["code"]!!
        .jsonPrimitive
        .content,
    )
    runtime.close()
  }

  @Test
  fun `cap releases slots and timeout availability unsupported and invalid args are typed`() =
    runTest {
      val module = FakePlatformModule().apply { execute = { awaitCancellation() } }
      val events = mutableListOf<PrototypeEvent>()
      val runtime = runtime(module, events)
      repeat(PrototypePlatformDispatcher.MAX_IN_FLIGHT + 1) { runtime.tap(action(into = null)) }
      runtime
        .startPlatformModules() // Idempotent, with hot-flow subscriptions ready before returning.
      assertEquals(1, module.events.subscriptionCount.value)
      runCurrent()
      assertEquals(PrototypePlatformDispatcher.MAX_IN_FLIGHT, module.calls.size)
      assertEquals(
        "too_many_in_flight",
        outcomes(events)
          .single()
          .payload!!
          .jsonObject["error"]!!
          .jsonObject["code"]!!
          .jsonPrimitive
          .content,
      )
      advanceTimeBy(PrototypePlatformDispatcher.DEFAULT_TIMEOUT_MS.toLong())
      runCurrent()
      assertEquals(PrototypePlatformDispatcher.MAX_IN_FLIGHT + 1, outcomes(events).size)
      module.available = PlatformAvailability.NeedsPermission(setOf("camera"))
      runtime.tap(action())
      runCurrent()
      assertEquals(
        "permission_denied",
        outcomes(events)
          .last()
          .payload!!
          .jsonObject["error"]!!
          .jsonObject["code"]!!
          .jsonPrimitive
          .content,
      )
      module.available = PlatformAvailability.Unavailable("offline")
      runtime.tap(action())
      runCurrent()
      assertEquals(
        "unavailable",
        outcomes(events)
          .last()
          .payload!!
          .jsonObject["error"]!!
          .jsonObject["code"]!!
          .jsonPrimitive
          .content,
      )
      assertEquals(
        setOf("prototype_platform_device_v1", "prototype_platform_test_v1"),
        runtime.platformRegistry.capabilities,
      )
      assertTrue(Platform(listOf(module)).capabilities.contains(module.capability))
      runtime.close()
    }

  @Test
  fun `async follow ups retain their originating event without leaking to taps`() = runTest {
    val module =
      FakePlatformModule().apply {
        execute = { call ->
          delay((call.args["delayMs"] as? JsonPrimitive)?.long ?: 0)
          PlatformCallResult.Success(call.args.getValue("message"))
        }
      }
    val events = mutableListOf<PrototypeEvent>()
    val follow =
      PrototypePlatformAction(
        "test.echo",
        mapOf("message" to obj("event" to JsonPrimitive("/count"))),
        into = "/data/observed",
      )
    val runtime =
      runtime(
        module,
        events,
        spec(mapOf("test.tick" to listOf(action(10, follow = listOf(follow))))),
      )
    runCurrent()
    module.events.emit(PlatformEvent("test.tick", obj("count" to JsonPrimitive(3))))
    runCurrent()
    module.events.emit(PlatformEvent("test.tick", obj("count" to JsonPrimitive(5))))
    runCurrent()
    advanceTimeBy(10)
    runCurrent()
    assertEquals(
      listOf(JsonPrimitive("hello"), JsonPrimitive("hello"), JsonPrimitive(3), JsonPrimitive(5)),
      module.calls.map { it.args["message"] },
    )
    assertEquals(JsonPrimitive(5), runtime.current.spec.data!!["observed"])
    runtime.tap(
      PrototypePlatformAction(
        "test.echo",
        mapOf("message" to obj("event" to JsonPrimitive("/count"))),
      ),
    )
    assertEquals(
      "invalid_args",
      outcomes(events)
        .last()
        .payload!!
        .jsonObject["error"]!!
        .jsonObject["code"]!!
        .jsonPrimitive
        .content,
    )
    runtime.close()
  }

  @Test
  fun `module cancellation releases the shared cap and reports cancelled`() = runTest {
    val module = FakePlatformModule().apply { execute = { throw CancellationException("cancel") } }
    val events = mutableListOf<PrototypeEvent>()
    val runtime = runtime(module, events, inFlight = 1)
    repeat(2) {
      runtime.tap(action())
      runCurrent()
    }
    assertEquals(2, module.calls.size)
    assertTrue(
      outcomes(events).all {
        it.payload!!.jsonObject["error"]!!.jsonObject["code"] == JsonPrimitive("cancelled")
      },
    )
    runtime.close()
  }

  @Test
  fun `arguments read committed state before the loading write`() = runTest {
    val module = FakePlatformModule()
    val runtime = runtime(module, mutableListOf())
    runtime.tap(action().copy(args = mapOf("message" to obj("state" to JsonPrimitive("status")))))
    assertEquals(PrototypeScalar.Text("loading"), runtime.current.state["status"])
    runCurrent()
    assertEquals(JsonPrimitive("idle"), module.calls.single().args["message"])
    assertEquals(JsonPrimitive("idle"), runtime.current.spec.data!!["result"])
    runtime.close()
  }
}
