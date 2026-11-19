package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
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
class PrototypePlatformSimulationTest {
  private val fixture =
    Json.parseToJsonElement(
        fixtureFile("prototype-spec/platform-simulation/test-tick.json").readText(),
      )
      .jsonObject
  private val name = fixture.getValue("event").jsonPrimitive.content
  private val data = fixture.getValue("data").jsonObject
  private val spec =
    PrototypeSpec(
      "panel",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "{platform:/test/count}"),
      requires = PrototypeRequires(platform = listOf("test")),
      platform =
        PrototypePlatformHandlers(
          mapOf(
            name to
              listOf(
                PrototypeSetDataAction(
                  "/data/fromEvent",
                  buildJsonObject { put("event", "/count") },
                ),
                PrototypeSetDataAction(
                  "/data/fromPlatform",
                  buildJsonObject { put("platform", "/test/count") },
                ),
              ),
          ),
        ),
      data =
        buildJsonObject {
          put("fromEvent", 0)
          put("fromPlatform", 0)
        },
    )

  private fun TestScope.runtime(
    module: PrototypePlatformModule,
    events: MutableList<PrototypeEvent>,
    input: PrototypeSpec = spec,
  ): PrototypeRuntime {
    var sequence = 0L
    return PrototypeRuntime(
        input,
        sink = { events += it },
        clock = { testScheduler.currentTime },
        nextSequence = { ++sequence },
        requestScope = backgroundScope,
        platform = Platform(listOf(module)),
        warn = { error(it) },
      )
      .also { it.startPlatformModules() }
  }

  @Test
  fun `shared injected event equals a real event except the simulated marker`() = runTest {
    val realModule = TestPlatformModule()
    val realEvents = mutableListOf<PrototypeEvent>()
    val real = runtime(realModule, realEvents)
    val simulatedEvents = mutableListOf<PrototypeEvent>()
    val simulated = runtime(TestPlatformModule(), simulatedEvents)
    runCurrent()
    realModule.tick(data)
    runCurrent()
    assertTrue(simulated.simulatePlatformEvent(name, data))
    runCurrent()
    assertEquals(real.current.platformState, simulated.current.platformState)
    assertEquals(data, simulated.current.platformState["test"])
    assertEquals(real.current.spec.data, simulated.current.spec.data)
    assertEquals(data["count"], simulated.current.spec.data!!["fromEvent"])
    assertEquals(data["count"], simulated.current.spec.data!!["fromPlatform"])
    val realEvent = realEvents.single { it.name == PrototypePlatform.DELIVERED_EVENT_NAME }
    val injected = simulatedEvents.single { it.name == PrototypePlatform.DELIVERED_EVENT_NAME }
    assertEquals(fixture["expected"], injected.payload)
    assertEquals(
      realEvent,
      injected.copy(payload = JsonObject(injected.payload!!.jsonObject - "simulated")),
    )
    real.close()
    simulated.close()
  }

  @Test
  fun `module default returns unsupported without delivery or state writes`() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    val subject = runtime(FakePlatformModule(), events)
    runCurrent()
    val before = subject.current
    assertFalse(subject.simulatePlatformEvent(name, data))
    assertEquals(before, subject.current)
    assertTrue(events.isEmpty())
    subject.close()
  }

  @Test
  fun `unknown undeclared and oversized events are refused before module mutation`() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    val module = TestPlatformModule()
    val subject = runtime(module, events)
    for ((event, payload) in
      listOf(
        "test.unknown" to data,
        "missing.tick" to data,
        name to buildJsonObject { put("text", "😀".repeat(1024)) },
      )) {
      assertTrue(
        runCatching { subject.simulatePlatformEvent(event, payload) }.exceptionOrNull()
          is IllegalArgumentException,
      )
    }
    val undeclared = runtime(module, events, spec.copy(requires = null))
    assertTrue(
      runCatching { undeclared.simulatePlatformEvent(name, data) }.exceptionOrNull()
        is IllegalArgumentException,
    )
    assertTrue(module.state.value.isEmpty())
    assertTrue(events.isEmpty())
    subject.close()
    undeclared.close()
  }
}
