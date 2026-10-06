package dev.jasonpearson.automobile.junit

import java.net.ConnectException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertSame
import kotlin.test.assertTrue
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Before
import org.junit.Test

/**
 * A daemon that dies leaving its socket file behind must be restarted instead of failing every
 * remaining test with a raw "Connection refused" (#10169).
 */
class DaemonSocketRecoveryTest {
  private val socketPath = "/tmp/auto-mobile-daemon-test.sock"

  @Before
  fun setup() {
    DaemonSocketClientManager.resetStateForTest()
  }

  @After
  fun tearDown() {
    DaemonSocketClientManager.testConnector = null
    DaemonSocketClientManager.testClient = null
    DaemonSocketClientManager.resetStateForTest()
    AutoMobileSharedUtils.testDeviceChecker = null
    DaemonHeartbeat.testController = null
    AutoMobilePlanExecutor.testAgent = null
    AutoMobilePlanExecutor.retryBackoffMs = 2000L
  }

  @Test
  fun refusedConnectRecoversThroughEnsureRunningOnce() {
    val client = Any()
    var connects = 0
    var recoveries = 0

    val result =
      connectWithDaemonRecovery(
        socketPath,
        connect = {
          connects++
          if (connects == 1) throw ConnectException("Connection refused")
          client
        },
        sleep = { error("no sleep needed when the first retry connects") },
        recover = { recoveries++ },
      )

    assertSame(client, result)
    assertEquals(1, recoveries)
    assertEquals(2, connects)
  }

  @Test
  fun healthyConnectNeverRunsRecovery() {
    val result =
      connectWithDaemonRecovery(
        socketPath,
        connect = { "client" },
        sleep = { error("unused") },
        recover = { error("unused") },
      )

    assertEquals("client", result)
  }

  @Test
  fun daemonThatStaysDownSurfacesAClearErrorNamingTheSocket() {
    var connects = 0
    var recoveries = 0
    val sleeps = mutableListOf<Long>()

    val error =
      assertFailsWith<DaemonUnavailableException> {
        connectWithDaemonRecovery<Any>(
          socketPath,
          connect = {
            connects++
            throw ConnectException("Connection refused")
          },
          sleep = { sleeps.add(it) },
          recover = { recoveries++ },
        )
      }

    assertEquals(1, recoveries)
    // One initial attempt plus a bounded number of post-recovery attempts, with backoff between.
    assertEquals(4, connects)
    assertEquals(listOf(100L, 200L), sleeps)
    val message = error.message.orEmpty()
    assertTrue(message.contains(socketPath))
    assertTrue(message.contains("Connection refused"))
    assertTrue(error.cause is ConnectException)
  }

  @Test
  fun unrelatedFailuresAreNotTreatedAsDaemonDown() {
    assertFailsWith<IllegalStateException> {
      connectWithDaemonRecovery<Any>(
        socketPath,
        connect = { throw IllegalStateException("bug") },
        sleep = {},
        recover = { error("must not recover from a non-connection failure") },
      )
    }
  }

  @Test
  fun managerRestartsDeadDaemonAndReusesTheNewClientOnTheSameThread() {
    val connector = FakeConnector(socketPath)
    connector.connectOutcomes.addAll(
      listOf(Outcome.Ok, Outcome.Refused, Outcome.Ok) // test 1 ok; test 2 refused then recovers
    )
    DaemonSocketClientManager.testConnector = connector

    val first = DaemonSocketClientManager.callTool("observe", JsonObject(emptyMap()), 1000)
    assertTrue(first.success)
    assertEquals(1, connector.ensureCalls)

    // The daemon dies with its socket file left behind: the cached client is no longer connected.
    connector.clients.single().connected = false
    val second = DaemonSocketClientManager.callTool("observe", JsonObject(emptyMap()), 1000)

    assertTrue(second.success)
    assertEquals(2, connector.ensureCalls)
    assertEquals(2, connector.clients.size)
    assertTrue(connector.sleeps.isEmpty())
  }

  @Test
  fun managerFailureNamesTheSocketWhenTheDaemonCannotBeRestarted() {
    val connector = FakeConnector(socketPath)
    connector.alwaysRefuse = true
    DaemonSocketClientManager.testConnector = connector

    val error =
      assertFailsWith<DaemonUnavailableException> {
        DaemonSocketClientManager.callTool("observe", JsonObject(emptyMap()), 1000)
      }

    assertTrue(error.message.orEmpty().contains(socketPath))
    assertTrue(error.cause is ConnectException)
    // Initial ensure + exactly one recovery ensure.
    assertEquals(2, connector.ensureCalls)
  }

  @Test
  fun planExecutionAgainstADeadDaemonReportsAFailureNamingTheDaemon() {
    val connector = FakeConnector(socketPath)
    connector.alwaysRefuse = true
    DaemonSocketClientManager.testConnector = connector
    AutoMobileSharedUtils.testDeviceChecker = AvailableDeviceChecker()
    DaemonHeartbeat.testController = NoopHeartbeat()
    AutoMobilePlanExecutor.testAgent =
      AutoMobileAgent(recoveryConfigProvider = StaticRecoveryConfigProvider(enabled = false))
    AutoMobilePlanExecutor.retryBackoffMs = 0L

    val result =
      AutoMobilePlanExecutor.execute(
        "test-plans/launch-clock-app.yaml",
        emptyMap(),
        AutoMobilePlanExecutionOptions(maxRetries = 1, aiAssistance = false),
      )

    assertFalse(result.success)
    val message = assertNotNull(result.errorMessage)
    assertTrue(message.contains("daemon", ignoreCase = true), message)
    assertTrue(message.contains(socketPath), message)
    assertFalse(message.contains("Plan execution failed: Connection refused"), message)
  }

  private enum class Outcome {
    Ok,
    Refused,
  }

  private class FakeClient : DaemonToolClient {
    var connected = true
    override var sessionUuid: String = "fake-session"

    override fun isConnected(): Boolean = connected

    override fun callTool(toolName: String, arguments: JsonObject, timeoutMs: Long) =
      DaemonResponse(id = "1", type = "mcp_response", success = true)

    override fun readResource(uri: String, timeoutMs: Long) =
      DaemonResponse(id = "1", type = "mcp_response", success = true)
  }

  private class FakeConnector(private val path: String) : DaemonSocketConnector {
    val connectOutcomes = ArrayDeque<Outcome>()
    var alwaysRefuse = false
    var ensureCalls = 0
    val clients = mutableListOf<FakeClient>()
    val sleeps = mutableListOf<Long>()

    override fun socketPath(): String = path

    // The dead daemon's socket file is still on disk.
    override fun socketExists(): Boolean = true

    override fun connect(): DaemonToolClient {
      val outcome = if (alwaysRefuse) Outcome.Refused else connectOutcomes.removeFirst()
      if (outcome == Outcome.Refused) throw ConnectException("Connection refused")
      return FakeClient().also { clients.add(it) }
    }

    override fun ensureDaemonRunning() {
      ensureCalls++
    }

    override fun sleep(ms: Long) {
      sleeps.add(ms)
    }
  }

  private class AvailableDeviceChecker : DeviceChecker {
    override fun checkDeviceAvailability() = Unit

    override fun areDevicesAvailable(): Boolean = true

    override fun getDeviceCount(): Int = 1
  }

  private class NoopHeartbeat : DaemonHeartbeatController {
    override fun startBackground(intervalMs: Long) = java.io.Closeable {}

    override fun registerSession(sessionId: String) = Unit

    override fun unregisterSession(sessionId: String) = Unit
  }
}
