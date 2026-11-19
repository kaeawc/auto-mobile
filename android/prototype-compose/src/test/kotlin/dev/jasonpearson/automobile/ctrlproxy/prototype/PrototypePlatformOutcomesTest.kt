package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PrototypePlatform as Platform
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import dev.jasonpearson.automobile.prototype.TestPlatformModule
import dev.jasonpearson.automobile.prototype.fixtureFile
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypePlatformOutcomesTest {
  private val spec =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "Echo"),
      data = buildJsonObject { put("result", "initial") },
      requires = PrototypeRequires(platform = listOf("test")),
    )
  private val scripted = buildJsonObject { put("result", "scripted") }
  private val args = buildJsonObject { put("message", "real") }

  private class CountingModule(
    private val real: TestPlatformModule = TestPlatformModule(wait = { assertEquals(0L, it) }),
  ) : PrototypePlatformModule by real {
    var availabilityChecks = 0
    var calls = 0

    override fun availability() = real.availability().also { availabilityChecks++ }

    override suspend fun call(call: PlatformCall) = real.call(call).also { calls++ }
  }

  private fun TestScope.runtime(
    module: PrototypePlatformModule? = CountingModule(),
    input: PrototypeSpec = spec,
    events: MutableList<PrototypeEvent> = mutableListOf(),
  ) =
    PrototypeRuntime(
      input,
      sink = { events += it },
      clock = { testScheduler.currentTime },
      monotonicMs = { testScheduler.currentTime },
      nextSequence = { events.size.toLong() + 1 },
      requestScope = backgroundScope,
      platform = Platform(listOfNotNull(module)),
      warn = { error(it) },
    )

  private suspend fun PrototypeRuntime.echo(args: JsonObject, call: String = "test.echo") {
    val action =
      PrototypePlatformAction(
        call,
        args.mapValues { (_, value) -> buildJsonObject { put("value", value) } },
        into = "/data/result",
        onSuccess = listOf(PrototypeEmitAction("echo-succeeded")),
        onError = listOf(PrototypeEmitAction("echo-failed")),
      )
    handle(PrototypeInteraction.Tap(listOf(action)))
  }

  @Test
  fun `fixture results settle normally and only fallthrough calls the module`() = runTest {
    val steps =
      Json.parseToJsonElement(
          fixtureFile("prototype-spec/platform-simulation/test-echo-outcomes.json").readText(),
        )
        .jsonArray
    val module = CountingModule()
    val events = mutableListOf<PrototypeEvent>()
    val runtime = runtime(module, events = events)
    for (step in steps.map { it.jsonObject }) {
      val queued = step["queue"]
      if (queued != null) {
        runtime.queueCallOutcome("test.echo", queued.jsonObject)
        continue
      }
      runtime.echo(step.getValue("args").jsonObject, step.getValue("call").jsonPrimitive.content)
      runCurrent()
      val expected = step.getValue("expected").jsonObject
      val event = events.last { it.name == PrototypePlatform.CALL_EVENT_NAME }.payload!!.jsonObject
      assertEquals(expected["error"], event["error"])
      if (expected.containsKey("result")) {
        assertEquals(expected["result"], runtime.current.spec.data?.get("result"))
        assertEquals("echo-succeeded", events.last().name)
      } else {
        assertEquals("echo-failed", events.last().name)
      }
      val realCalls = if (expected["result"] == JsonPrimitive("real")) 1 else 0
      assertEquals(realCalls, module.availabilityChecks)
      assertEquals(realCalls, module.calls)
    }
    runtime.close()
  }

  @Test
  fun `history is isolated by call and cleared by show while invalid args leave queue untouched`() =
    runTest {
      val module = CountingModule()
      val events = mutableListOf<PrototypeEvent>()
      val runtime = runtime(module, events = events)
      runtime.queueCallOutcome("test.protected", scripted)
      runtime.queueCallOutcome("test.echo", scripted)
      runtime.echo(buildJsonObject { put("message", 123) })
      assertEquals(
        JsonPrimitive("invalid_args"),
        events
          .last { it.name == PrototypePlatform.CALL_EVENT_NAME }
          .payload!!
          .jsonObject
          .getValue("error")
          .jsonObject["code"],
      )
      assertEquals(0, module.availabilityChecks)
      runtime.echo(args)
      runCurrent()
      assertEquals(JsonPrimitive("scripted"), runtime.current.spec.data?.get("result"))
      assertEquals(0, module.calls)
      runtime.echo(args)
      runCurrent()
      assertEquals(1, module.calls)
      runtime.queueCallOutcome("test.echo", scripted)
      runtime.shown(preservingState = true)
      runtime.echo(args)
      runCurrent()
      assertEquals(2, module.calls)
      runtime.close()
      assertThrows(IllegalStateException::class.java) {
        runtime.queueCallOutcome("test.echo", scripted)
      }
    }

  @Test
  fun `refusals leave slots available and the seventeenth outcome is refused`() = runTest {
    val runtime = runtime()
    val unregistered = runtime(null)
    val unsupported = runtime(FakePlatformModule())
    val undeclared = runtime(input = spec.copy(requires = null))
    for ((subject, call, hint) in
      listOf(
        Triple(unregistered, "test.echo", "No module registered"),
        Triple(unsupported, "test.echo", "does not support simulation"),
        Triple(undeclared, "test.echo", "requires.platform"),
        Triple(runtime, "test.unknown", "Unknown platform call"),
      )) {
      val error =
        assertThrows(IllegalArgumentException::class.java) {
          subject.queueCallOutcome(call, scripted)
        }
      assertTrue(error.message.orEmpty().contains(hint))
    }
    for (bad in
      listOf(
        JsonObject(emptyMap()),
        buildJsonObject { put("result", "😀".repeat(1024)) },
        buildJsonObject { put("error", buildJsonObject { put("code", "unknown") }) },
      )) {
      assertThrows(IllegalArgumentException::class.java) {
        runtime.queueCallOutcome("test.echo", bad)
      }
    }
    repeat(16) { runtime.queueCallOutcome("test.echo", scripted) }
    val full =
      assertThrows(IllegalArgumentException::class.java) {
        runtime.queueCallOutcome("test.echo", scripted)
      }
    assertTrue(full.message.orEmpty().contains("At most 16"))
    runtime.queueCallOutcome("test.protected", scripted)
    runtime.echo(args)
    runCurrent()
    runtime.queueCallOutcome("test.echo", scripted)
    listOf(runtime, unregistered, unsupported, undeclared).forEach { it.close() }
  }
}
