package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.ctrlproxy.prototype.ConnectivityTransport.CELLULAR
import dev.jasonpearson.automobile.ctrlproxy.prototype.ConnectivityTransport.ETHERNET
import dev.jasonpearson.automobile.ctrlproxy.prototype.ConnectivityTransport.VPN
import dev.jasonpearson.automobile.ctrlproxy.prototype.ConnectivityTransport.WIFI
import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PlatformEvent
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Connectivity platform module (#14273): state mapping, tracker and the debounced event. */
@OptIn(ExperimentalCoroutinesApi::class)
class PrototypeConnectivityTest {
  private class FakeSource(val tracker: ConnectivityTracker = ConnectivityTracker()) :
    PrototypeConnectivitySource {
    var closed = false
    var reads = 0
    override val state: StateFlow<JsonObject>
      get() {
        reads++
        return tracker.state
      }

    override fun close() {
      closed = true
    }
  }

  private fun expected(online: Boolean, transport: String, metered: Boolean, constrained: Boolean) =
    buildJsonObject {
      put("online", online)
      put("transport", transport)
      put("metered", metered)
      put("constrained", constrained)
    }

  private fun network(
    vararg transports: ConnectivityTransport,
    validated: Boolean = true,
    notMetered: Boolean = true,
  ) = ConnectivityNetwork(validated, notMetered, transports.toSet())

  @Test
  fun `no default network is offline on none`() {
    assertEquals(
      expected(false, "none", false, false),
      PrototypeConnectivityState.of(null, dataSaver = true),
    )
  }

  @Test
  fun `validated decides online and an unvalidated network keeps its transport`() {
    assertEquals(
      expected(true, "wifi", false, false),
      PrototypeConnectivityState.of(network(WIFI), dataSaver = false),
    )
    assertEquals(
      expected(false, "wifi", false, false),
      PrototypeConnectivityState.of(network(WIFI, validated = false), dataSaver = false),
    )
  }

  @Test
  fun `transport prefers vpn then wifi cellular ethernet and falls back to other`() {
    val cases =
      listOf(
        setOf(VPN, WIFI) to "vpn",
        setOf(WIFI, CELLULAR) to "wifi",
        setOf(CELLULAR) to "cellular",
        setOf(ETHERNET) to "ethernet",
        emptySet<ConnectivityTransport>() to "other",
      )
    for ((transports, name) in cases) {
      val state = PrototypeConnectivityState.of(ConnectivityNetwork(true, true, transports), false)
      assertEquals(transports.toString(), name, state["transport"].toString().trim('"'))
    }
  }

  @Test
  fun `metered follows NOT_METERED and constrained is Data Saver on a metered network`() {
    assertEquals(
      expected(true, "cellular", true, false),
      PrototypeConnectivityState.of(network(CELLULAR, notMetered = false), dataSaver = false),
    )
    assertEquals(
      expected(true, "cellular", true, true),
      PrototypeConnectivityState.of(network(CELLULAR, notMetered = false), dataSaver = true),
    )
    assertEquals(
      expected(true, "wifi", false, false),
      PrototypeConnectivityState.of(network(WIFI), dataSaver = true),
    )
  }

  @Test
  fun `tracker publishes network and Data Saver changes`() {
    val tracker = ConnectivityTracker()
    tracker.onNetwork(network(CELLULAR, notMetered = false))
    tracker.onDataSaver(true)
    assertEquals(expected(true, "cellular", true, true), tracker.state.value)
    tracker.onNetwork(null)
    assertEquals(expected(false, "none", false, false), tracker.state.value)
  }

  @Test
  fun `registering the module does not start the source`() {
    val source = FakeSource()
    PrototypeConnectivityModule(source, debounceMs = 500).events
    assertEquals(0, source.reads)
  }

  @Test
  fun `module state is the source state and calls are unsupported`() = runTest {
    val source = FakeSource(ConnectivityTracker(network(WIFI)))
    val module = PrototypeConnectivityModule(source, debounceMs = 500)
    assertEquals("connectivity", module.name)
    assertEquals("prototype_platform_connectivity_v1", module.capability)
    assertEquals(expected(true, "wifi", false, false), module.state.value)
    val result = module.call(PlatformCall("c", "connectivity.read", JsonObject(emptyMap())))
    assertEquals(
      PlatformErrorCode.UNSUPPORTED,
      (result as PlatformCallResult.Failure).error.code,
    )
    module.close()
    assertTrue(source.closed)
  }

  @Test
  fun `changed is delivered once after the state is quiet for the debounce`() = runTest {
    val source = FakeSource(ConnectivityTracker(network(WIFI)))
    val module = PrototypeConnectivityModule(source, debounceMs = 500)
    val events = mutableListOf<PlatformEvent>()
    val job = launch { module.events.collect { events += it } }
    runCurrent()
    source.tracker.onNetwork(null)
    advanceTimeBy(300)
    source.tracker.onNetwork(network(CELLULAR, notMetered = false))
    advanceTimeBy(499)
    runCurrent()
    assertTrue(events.isEmpty())
    advanceTimeBy(2)
    runCurrent()
    assertEquals(
      listOf(PlatformEvent("connectivity.changed", expected(true, "cellular", true, false))),
      events,
    )
    job.cancel()
  }

  @Test
  fun `a flap that settles on the delivered state is not an event`() = runTest {
    val source = FakeSource(ConnectivityTracker(network(WIFI)))
    val module = PrototypeConnectivityModule(source, debounceMs = 500)
    val events = mutableListOf<PlatformEvent>()
    val job = launch { module.events.collect { events += it } }
    runCurrent()
    source.tracker.onNetwork(null)
    advanceTimeBy(100)
    source.tracker.onNetwork(network(WIFI))
    advanceTimeBy(1_000)
    runCurrent()
    assertTrue(events.isEmpty())
    job.cancel()
  }

  @Test
  fun `the default debounce is the contract's connectivity changed debounce`() {
    assertEquals(500L, PrototypePlatformCalls.eventDebounceMs("connectivity.changed"))
    assertEquals(250L, PrototypePlatformCalls.eventDebounceMs("device.changed"))
    assertEquals(null, PrototypePlatformCalls.eventDebounceMs("realtime.frame"))
    assertEquals(null, PrototypePlatformCalls.eventDebounceMs("nope.changed"))
  }
}
