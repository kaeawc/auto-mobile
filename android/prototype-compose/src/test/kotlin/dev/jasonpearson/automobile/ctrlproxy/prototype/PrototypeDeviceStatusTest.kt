package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PrototypePlatformRegistry
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeDeviceStatusTest {
  private class FakeSource : PrototypeDeviceStatusSource {
    val tracker = DeviceStatusTracker()
    var reads = 0
    var closed = false
    override val state: StateFlow<JsonObject>
      get() {
        reads++
        return tracker.state
      }

    override fun close() {
      closed = true
    }
  }

  @Test
  fun `registering all status modules stays lazy and close forwards to each source`() = runTest {
    val sources = DeviceStatusKind.entries.map { FakeSource() }
    val modules =
      DeviceStatusKind.entries.zip(sources).map { (kind, source) ->
        PrototypeDeviceStatusModule(kind, source)
      }
    val registry = PrototypePlatformRegistry(modules)
    assertEquals(setOf("battery", "power", "audio"), registry.modules.map { it.name }.toSet())
    assertEquals(
      setOf(
        "prototype_platform_battery_v1",
        "prototype_platform_power_v1",
        "prototype_platform_audio_v1",
      ),
      registry.capabilities,
    )
    modules.zip(sources).forEach { (module, source) ->
      module.events
      assertEquals(0, source.reads)
      assertSame(source.tracker.state, module.state)
      assertEquals(PlatformAvailability.Ready, module.availability())
      assertEquals(500L, PrototypePlatformCalls.eventDebounceMs("${module.name}.changed"))
      val result = module.call(PlatformCall("c", "${module.name}.read", JsonObject(emptyMap())))
      assertEquals(PlatformErrorCode.UNSUPPORTED, (result as PlatformCallResult.Failure).error.code)
      module.close()
      assertTrue(source.closed)
    }
  }

  @Test
  fun `tracker immediately publishes snapshots and omits newly unknown keys`() {
    val tracker = DeviceStatusTracker(PrototypeDeviceStatus.battery(50, 100, 2))
    tracker.update(PrototypeDeviceStatus.battery(-1, 100, 1))
    assertEquals(PrototypeDeviceStatus.battery(-1, 100, 1), tracker.state.value)
    val power = PrototypeDeviceStatus.power(true, 3)
    tracker.update(power)
    tracker.update(power)
    assertEquals(power, tracker.state.value)
  }
}
