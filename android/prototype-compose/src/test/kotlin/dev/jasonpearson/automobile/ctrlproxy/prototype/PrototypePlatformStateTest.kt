package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypePlatformStateTest {
  companion object {
    @JvmStatic
    @BeforeClass
    fun warm() {
      PrototypeSpecValidator.validate("{}")
      PrototypeDeviceContract.breakpoints("widthClass")
      runTest {
        val runtime =
          PrototypeRuntime(
            deviceSpec(),
            nextSequence = { 1L },
            requestScope = backgroundScope,
            warn = { error(it) },
          )
        runtime.handle(PrototypeInteraction.DeviceState(state(400f)))
        runtime.renderModel()
        runtime.handle(PrototypeInteraction.DeviceState(state(840f, true)))
        runtime.renderModel()
        runCurrent()
        advanceTimeBy(250)
        runCurrent()
        runtime.close()
        val source = PrototypeFoldSource { flowOf(PrototypeFold.NONE) }
        source
          .deviceSnapshots(
            flowOf(PrototypeDeviceInput(400f, 800f, 400, PrototypeFold.NONE, false, "16", false)),
          )
          .first()
      }
    }

    private fun state(width: Float, pointer: Boolean = false) =
      PrototypeDeviceState.snapshot(
        PrototypeDeviceInput(width, 800f, 400, PrototypeFold.NONE, pointer, "16", false),
      )

    private fun deviceSpec(): PrototypeSpec =
      PrototypeSpec(
        "device",
        PrototypeWindow(PrototypeFullscreenPlacement()),
        root =
          PrototypeTextNode(
            text = "{platform:/device/widthClass}",
            visibleWhen =
              PrototypeCondition(
                platform = "/device/widthClass",
                equals = PrototypeScalar.Text("expanded"),
              ),
          ),
        data = buildJsonObject { put("pointer", false) },
        requires = PrototypeRequires(platform = listOf("device")),
        platform =
          PrototypePlatformHandlers(
            mapOf(
              "device.changed" to
                listOf(
                  PrototypeSetDataAction(
                    "/data/pointer",
                    buildJsonObject { put("event", "/pointer") },
                  ),
                ),
            ),
          ),
      )
  }

  @Test
  fun `seed is mapped before any frame and never delivers a changed event`() = runTest {
    val events = mutableListOf<PrototypeEvent>()
    val runtime =
      PrototypeRuntime(
        deviceSpec(),
        sink = { events += it },
        nextSequence = { 1L },
        requestScope = backgroundScope,
        initialPlatformState = state(840f),
      )
    assertEquals(state(840f), runtime.current.platformState)
    assertEquals("expanded", runtime.renderModel().root.text)
    runtime.handle(PrototypeInteraction.DeviceState(state(840f)))
    advanceTimeBy(1000)
    runCurrent()
    assertTrue(events.isEmpty())
    runtime.close()
  }

  @Test
  fun `fake posture source refreshes snapshots without changing window measurements`() = runTest {
    val fold = MutableStateFlow(PrototypeFold.NONE)
    val source = PrototypeFoldSource { fold }
    val inputs =
      MutableStateFlow(
        PrototypeDeviceInput(700f, 500f, 400, PrototypeFold.NONE, false, "16", false),
      )
    val snapshots = mutableListOf<JsonObject>()
    backgroundScope.launch { source.deviceSnapshots(inputs).toList(snapshots) }
    runCurrent()
    fold.value = PrototypeFold.HALF_OPENED_HORIZONTAL
    runCurrent()
    assertEquals(2, snapshots.size)
    assertEquals(
      JsonPrimitive("tabletop"),
      snapshots.last().getValue("device").jsonObject["posture"],
    )
    assertEquals(JsonPrimitive(700), snapshots.last().getValue("device").jsonObject["windowWidth"])
  }

  @Test
  fun `stale callbacks are ignored and delivery runs inside the interaction lock`() = runTest {
    val tasks = mutableListOf<suspend () -> Unit>()
    var locked = false
    var deliveries = 0
    val scheduler = PrototypeScheduler { delay, task ->
      assertEquals(250L, delay)
      tasks += task
      PrototypeScheduledTask {}
    }
    val store =
      PrototypePlatformState(
        scheduler,
        { action ->
          locked = true
          try {
            action()
          } finally {
            locked = false
          }
        },
      ) { _, _ ->
        assertTrue(locked)
        deliveries++
      }
    store.update(state(400f))
    store.update(state(600f))
    store.update(state(840f))
    tasks.first()()
    assertEquals(0, deliveries)
    tasks.last()()
    assertEquals(1, deliveries)
  }

  @Test
  fun `initial and pixel or pointer only updates do not deliver`() = runTest {
    val delivered = mutableListOf<JsonObject>()
    val store =
      PrototypePlatformState(CoroutinePrototypeScheduler(backgroundScope)) { _, data ->
        delivered += data
      }
    assertTrue(store.update(state(400f)))
    assertFalse(store.update(state(400f)))
    store.update(state(401f, true))
    advanceTimeBy(1000)
    runCurrent()
    assertTrue(delivered.isEmpty())
    store.update(state(840f))
    store.close()
    advanceTimeBy(1000)
    runCurrent()
    assertTrue(delivered.isEmpty())
  }

  @Test
  fun `burst updates render immediately then deliver once with scoped handler bindings`() =
    runTest {
      val events = mutableListOf<PrototypeEvent>()
      val spec = deviceSpec()
      var sequence = 0L
      val runtime =
        PrototypeRuntime(
          spec,
          PrototypeEventSink { events += it },
          { testScheduler.currentTime },
          { ++sequence },
          requestScope = backgroundScope,
          warn = { error(it) },
        )
      suspend fun update(width: Float, pointer: Boolean = false) =
        runtime.handle(PrototypeInteraction.DeviceState(state(width, pointer)))
      update(400f)
      update(600f)
      runCurrent()
      advanceTimeBy(100)
      update(840f, true)
      runCurrent()
      assertEquals("expanded", runtime.renderModel().root.text)
      assertEquals(0L, runtime.current.revision)
      advanceTimeBy(249)
      runCurrent()
      assertTrue(events.isEmpty())
      advanceTimeBy(1)
      runCurrent()
      val event = events.single { it.name == PrototypePlatform.DELIVERED_EVENT_NAME }
      assertEquals(JsonPrimitive("device.changed"), event.payload!!.jsonObject["event"])
      assertEquals(state(840f, true)["device"], event.payload!!.jsonObject["data"])
      assertEquals(JsonPrimitive(true), runtime.current.spec.data!!["pointer"])
      assertTrue(runtime.current.revision > 0)
    }
}
