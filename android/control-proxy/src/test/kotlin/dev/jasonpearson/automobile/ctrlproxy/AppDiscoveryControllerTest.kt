package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.KeystoreDiscoveryResult
import dev.jasonpearson.automobile.protocol.KeystoreDiscoveryState
import dev.jasonpearson.automobile.protocol.SdkCapabilitiesResult
import dev.jasonpearson.automobile.protocol.SdkCapabilitiesState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class AppDiscoveryControllerTest {
  private class FixedTimer : TimeProvider {
    override fun currentTimeMillis() = 7_007L
  }

  /** An app whose bridge answers per package, records each read, and can throw instead. */
  private class FakeBridge : AppDiscoveryController.Source {
    var failWith: RuntimeException? = null
    val reads = mutableListOf<String>()

    override fun resetKeystore(
      packageName: String,
      scope: String?,
      alias: String?,
    ): dev.jasonpearson.automobile.protocol.KeystoreResetState {
      reads += "reset:$packageName:$scope:$alias"
      return dev.jasonpearson.automobile.protocol.KeystoreResetState(
        outcome = "ok",
        bridgeAvailable = true,
        status = "deleted",
        deletedCount = 1,
      )
    }

    override fun keystore(packageName: String): KeystoreDiscoveryState {
      reads += "keystore:$packageName"
      failWith?.let { throw it }
      return KeystoreDiscoveryState(outcome = "available", bridgeAvailable = true)
    }

    override fun sdkCapabilities(packageName: String, userId: Int?): SdkCapabilitiesState {
      reads += "sdk:$packageName:$userId"
      failWith?.let { throw it }
      return SdkCapabilitiesState(outcome = "available", snapshot = JsonPrimitive(packageName))
    }
  }

  /** Counts perf-timing reads, which a capability snapshot must never consume. */
  private class CountingTransport : FakeResultTransport() {
    var perfFlushes = 0

    override fun flushPerfTiming() = super.flushPerfTiming().also { perfFlushes++ }
  }

  private val bridge = FakeBridge()
  private val transport = CountingTransport()
  private val errors = mutableListOf<ErrorResponse>()

  private fun controller(testScope: TestScope) =
    AppDiscoveryController(
      source = bridge,
      asyncActionRunner =
        AsyncActionRunner(
          scope = CoroutineScope(UnconfinedTestDispatcher(testScope.testScheduler)),
          broadcastResponse = { errors += it as ErrorResponse },
          logError = { _, _ -> },
        ),
      resultSender =
        guardedResultSender(
          transport,
          ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
        ),
      timeProvider = FixedTimer(),
    )

  @Test
  fun `reset forwards selectors and returns correlated result`() = runTest {
    controller(this).resetKeystore("kr1", "com.example", "login", "token")
    assertEquals(listOf("reset:com.example:login:token"), bridge.reads)
    val result =
      transport.sentResponses.single() as dev.jasonpearson.automobile.protocol.KeystoreResetResult
    assertEquals("kr1", result.requestId)
    assertEquals("deleted", result.state.status)
    assertEquals(1, result.state.deletedCount)
  }

  @Test
  fun `keystore discovery returns the bridge state under the request id`() = runTest {
    controller(this).discoverKeystore("ks1", "com.example")

    assertEquals(listOf("keystore:com.example"), bridge.reads)
    val result = transport.sentResponses.single() as KeystoreDiscoveryResult
    assertEquals("ks1", result.requestId)
    assertEquals(7_007L, result.timestamp)
    assertEquals(
      KeystoreDiscoveryState(outcome = "available", bridgeAvailable = true),
      result.state,
    )
    assertEquals("a capability snapshot carries no perf timing", 0, transport.perfFlushes)
  }

  @Test
  fun `sdk capability discovery reads the requested user's instance`() = runTest {
    val controller = controller(this)

    controller.discoverSdkCapabilities("sc1", "com.example", userId = null)
    controller.discoverSdkCapabilities("sc2", "com.example.work", userId = 10)

    assertEquals(listOf("sdk:com.example:null", "sdk:com.example.work:10"), bridge.reads)
    val results = transport.sentResponses.map { it as SdkCapabilitiesResult }
    assertEquals(listOf("sc1", "sc2"), results.map { it.requestId })
    assertEquals(JsonPrimitive("com.example.work"), results[1].state.snapshot)
    assertEquals(7_007L, results[1].timestamp)
    assertEquals(0, transport.perfFlushes)
  }

  @Test
  fun `a failed read becomes a correlated error instead of a hang`() = runTest {
    bridge.failWith = IllegalStateException("provider crashed")
    val controller = controller(this)

    controller.discoverKeystore("ks2", "com.example")
    controller.discoverSdkCapabilities("sc3", "com.example", userId = null)

    assertTrue(transport.sentResponses.isEmpty())
    assertEquals(listOf("ks2", "sc3"), errors.map { it.requestId })
  }
}
