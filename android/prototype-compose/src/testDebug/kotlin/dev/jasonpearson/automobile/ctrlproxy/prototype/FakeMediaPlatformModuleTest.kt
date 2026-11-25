package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import dev.jasonpearson.automobile.prototype.FakeMediaPlatformModule
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PlatformEvent
import dev.jasonpearson.automobile.prototype.PrototypePlatform as Platform
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class FakeMediaPlatformModuleTest {
  private fun spec(vararg players: String) =
    PrototypeSpec(
      "player",
      PrototypeWindow(PrototypeFullscreenPlacement()),
      root = PrototypeTextNode(text = "{platform:/media/players/main/status}"),
      requires = PrototypeRequires(platform = listOf("media")),
      media =
        buildJsonObject {
          put(
            "players",
            buildJsonObject {
              players.forEach { id ->
                put(
                  id,
                  buildJsonObject {
                    put("kind", "video")
                    put("source", buildJsonObject { put("url", "https://example.test/$id.mp4") })
                  },
                )
              }
            },
          )
        },
    )

  private fun TestScope.runtime(
    module: FakeMediaPlatformModule,
    events: MutableList<PrototypeEvent> = mutableListOf(),
  ): PrototypeRuntime {
    var sequence = 0L
    return PrototypeRuntime(
        spec("main"),
        sink = { events += it },
        clock = { testScheduler.currentTime },
        nextSequence = { ++sequence },
        requestScope = backgroundScope,
        platform = Platform(listOf(module)),
        warn = { error(it) },
      )
      .also { it.startPlatformModules() }
  }

  private fun PrototypeRuntime.player(id: String = "main"): JsonObject? =
    (current.platformState["media"] as? JsonObject)?.get("players")?.jsonObject?.get(id)?.jsonObject

  private fun data(vararg pairs: Pair<String, JsonElement>) = JsonObject(mapOf(*pairs))

  private fun call(name: String, vararg args: Pair<String, JsonElement>) =
    PlatformCall("call-1", name, data("player" to JsonPrimitive("main"), *args))

  @Test
  fun `the template advertises the media capability in fake mode`() {
    val module = FakeMediaPlatformModule()
    assertEquals("prototype_platform_media_v1", module.capability)
    assertEquals(PrototypePlatformReport.Mode.FAKE, module.platformMode)
    assertTrue(Platform(listOf(module)).registry.capabilities.contains(module.capability))
  }

  @Test
  fun `a runtime loads its spec's players paused at zero`() = runTest {
    val runtime = runtime(FakeMediaPlatformModule())
    runCurrent()
    val main = checkNotNull(runtime.player())
    assertEquals("ready", main.getValue("status").jsonPrimitive.content)
    assertEquals(false, main.getValue("playing").jsonPrimitive.boolean)
    assertEquals(0L, main.getValue("positionMs").jsonPrimitive.long)
    assertEquals(
      FakeMediaPlatformModule.FAKE_DURATION_MS,
      main.getValue("durationMs").jsonPrimitive.long,
    )
  }

  @Test
  fun `simulated media events change state and reach the host once, marked simulated`() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    val runtime = runtime(FakeMediaPlatformModule(), events)
    runCurrent()
    val buffering = data("player" to JsonPrimitive("main"), "status" to JsonPrimitive("buffering"))
    assertTrue(runtime.simulatePlatformEvent("media.statusChanged", buffering))
    assertEquals(true, runtime.player()?.getValue("buffering")?.jsonPrimitive?.boolean)
    val ended = data("player" to JsonPrimitive("main"), "advanceMs" to JsonPrimitive(5000))
    assertTrue(runtime.simulatePlatformEvent("media.ended", ended))
    runCurrent()
    assertEquals("ended", runtime.player()?.getValue("status")?.jsonPrimitive?.content)
    val delivered =
      events
        .mapNotNull { it.payload as? JsonObject }
        .filter {
          it["event"]?.jsonPrimitive?.content?.startsWith("media.") == true
        }
    assertEquals(
      listOf("media.statusChanged", "media.ended"),
      delivered.map { it.getValue("event").jsonPrimitive.content },
    )
    assertTrue(delivered.all { it["simulated"] == JsonPrimitive(true) })
  }

  @Test
  fun `a simulated event for an unknown player or status is refused`() = runTest {
    val runtime = runtime(FakeMediaPlatformModule())
    runCurrent()
    assertFalse(
      runtime.simulatePlatformEvent("media.ended", data("player" to JsonPrimitive("other"))),
    )
    val bad = data("player" to JsonPrimitive("main"), "status" to JsonPrimitive("dancing"))
    assertFalse(runtime.simulatePlatformEvent("media.statusChanged", bad))
    assertEquals("ready", runtime.player()?.getValue("status")?.jsonPrimitive?.content)
  }

  @Test
  fun `every runtime gets its own players`() = runTest {
    val module = FakeMediaPlatformModule()
    val first = runtime(module)
    val second = runtime(module)
    runCurrent()
    val buffering = data("player" to JsonPrimitive("main"), "status" to JsonPrimitive("buffering"))
    assertTrue(first.simulatePlatformEvent("media.statusChanged", buffering))
    assertEquals(true, first.player()?.getValue("buffering")?.jsonPrimitive?.boolean)
    assertEquals(false, second.player()?.getValue("buffering")?.jsonPrimitive?.boolean)
  }

  @Test
  fun `calls drive the player and emit the engine's transitions`() = runTest {
    val session = FakeMediaPlatformModule().session(backgroundScope)
    (session as PrototypeSpecAwareModule).configure(spec("main"))
    val emitted = mutableListOf<PlatformEvent>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      session.events.collect { emitted += it }
    }
    assertTrue(session.call(call("media.play")) is PlatformCallResult.Success)
    assertTrue(
      session.call(call("media.seek", "positionMs" to JsonPrimitive(90_000)))
        is PlatformCallResult.Success,
    )
    assertTrue(
      session.call(call("media.seekBy", "deltaMs" to JsonPrimitive(-1_000)))
        is PlatformCallResult.Success,
    )
    assertTrue(
      session.call(call("media.setCaptions", "track" to JsonPrimitive("en")))
        is PlatformCallResult.Success,
    )
    assertTrue(session.call(call("media.toggle")) is PlatformCallResult.Success)
    val main = session.state.value.getValue("players").jsonObject.getValue("main").jsonObject
    assertEquals(59_000L, main.getValue("positionMs").jsonPrimitive.long)
    assertEquals(false, main.getValue("playing").jsonPrimitive.boolean)
    assertEquals("en", main.getValue("captionTrack").jsonPrimitive.content)
    assertEquals(
      listOf(true, false),
      emitted
        .filter { it.name == "media.statusChanged" }
        .map { it.data.getValue("playing").jsonPrimitive.boolean },
    )
  }

  @Test
  fun `an unknown player, a missing argument and a foreign call are refused`() = runTest {
    val session = FakeMediaPlatformModule().session(backgroundScope)
    (session as PrototypeSpecAwareModule).configure(spec("main"))
    val unknown =
      session.call(PlatformCall("c", "media.play", data("player" to JsonPrimitive("other"))))
    assertEquals(
      PlatformErrorCode.INVALID_ARGS,
      (unknown as PlatformCallResult.Failure).error.code,
    )
    val missing = session.call(call("media.seek"))
    assertEquals(PlatformErrorCode.INVALID_ARGS, (missing as PlatformCallResult.Failure).error.code)
    val foreign = session.call(call("media.next"))
    assertEquals(PlatformErrorCode.UNSUPPORTED, (foreign as PlatformCallResult.Failure).error.code)
  }

  @Test
  fun `a replacement spec loads new players and releases removed ones`() = runTest {
    val session = FakeMediaPlatformModule().session(backgroundScope)
    val aware = session as PrototypeSpecAwareModule
    aware.configure(spec("main"))
    session.call(call("media.play"))
    aware.configure(spec("main", "trailer"))
    var players = session.state.value.getValue("players").jsonObject
    assertEquals(setOf("main", "trailer"), players.keys)
    assertEquals(
      true,
      players.getValue("main").jsonObject.getValue("playing").jsonPrimitive.boolean,
    )
    aware.configure(spec("trailer"))
    players = session.state.value.getValue("players").jsonObject
    assertEquals(setOf("trailer"), players.keys)
  }
}
