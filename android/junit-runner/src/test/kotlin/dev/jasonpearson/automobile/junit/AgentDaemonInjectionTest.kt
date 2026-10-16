package dev.jasonpearson.automobile.junit

import ai.koog.agents.core.agent.AIAgent
import java.io.Closeable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AgentDaemonInjectionTest {
  private var previousCiMode: String? = null

  @Before
  fun setUp() {
    LazyInitializer.clear()
    previousCiMode = System.getProperty("automobile.ci.mode")
    System.setProperty("automobile.ci.mode", "false")
  }

  @After
  fun tearDown() {
    LazyInitializer.clear()
    val previous = previousCiMode
    if (previous == null) System.clearProperty("automobile.ci.mode")
    else System.setProperty("automobile.ci.mode", previous)
  }

  @Test
  fun `recovery reads config and calls a tool through the injected daemon`() {
    val daemon = FakeDaemon()
    val factory = ToolCallingFactory()
    val agent =
      AutoMobileAgent.forDaemon(
        daemon,
        configProvider = FakeConfig,
        aiAgentFactory = factory,
      )
    assertEquals(emptyList<Pair<String, Long>>(), daemon.reads)
    assertEquals(emptyList<Pair<String, JsonObject>>(), daemon.calls)
    assertEquals(0, daemon.aliveChecks)

    val result =
      agent.attemptAiRecovery(
        FailedStepContext(0, "tapOn", "blocked", emptyList(), "steps: []", "fake-device"),
      )

    // The fake factory stops before creating/running an LLM agent, after exercising the MCP client.
    assertFalse(result.success)
    assertEquals(9, factory.maxToolCalls)
    assertEquals("{\"fake\":true}", factory.toolResult)
    assertEquals(
      listOf("automobile:config/feature-flags/ai-recovery" to 5000L),
      daemon.reads,
    )
    assertEquals(
      listOf("observe" to JsonObject(mapOf("deviceId" to JsonPrimitive("fake-device")))),
      daemon.calls,
    )
    assertEquals(listOf(30_000L), daemon.toolTimeouts)
    assertEquals(1, daemon.aliveChecks)
    assertFalse(agent.recoveryConfigProvider.isRecoveryEnabled())
    assertEquals(1, daemon.reads.size)
  }

  @Test
  fun `executor resolves one agent lazily and shares its config across failure and recovery`() {
    val defaultAgent = LazyInitializer.getAgent()
    val daemon = FakeDaemon(recoveryEnabled = true)
    val factory = ToolCallingFactory()
    var resolutions = 0
    val collaborators =
      PlanExecutorCollaborators(
        daemon = daemon,
        agent = {
          resolutions++
          AutoMobileAgent.forDaemon(daemon, configProvider = FakeConfig, aiAgentFactory = factory)
        },
        deviceChecker = FakeDevices,
        heartbeat = FakeHeartbeat,
      )
    val executor = PlanExecutor(collaborators)
    assertEquals(0, resolutions)
    assertEquals(0, daemon.reads.size)
    assertEquals(0, daemon.calls.size)

    repeat(2) {
      val result =
        executor.execute(
          "test-plans/launch-clock-app.yaml",
          emptyMap(),
          AutoMobilePlanExecutionOptions(),
        )

      assertFalse(result.success)
      assertTrue(result.aiRecoveryAttempted)
      assertEquals(1, resolutions)
      assertEquals(1, daemon.reads.size)
    }
    assertEquals(9, factory.maxToolCalls)
    assertEquals(
      listOf(
        "setToolEnabled",
        "executePlan",
        "observe",
        "setToolEnabled",
        "executePlan",
        "observe",
      ),
      daemon.calls.map { it.first },
    )
    assertSame(defaultAgent, LazyInitializer.getAgent())
  }

  @Test
  fun `executor default agent shares one config read between failure checks`() {
    val daemon = FakeDaemon()
    val executor =
      PlanExecutor(
        PlanExecutorCollaborators(
          daemon = daemon,
          deviceChecker = FakeDevices,
          heartbeat = FakeHeartbeat,
        ),
      )

    val result =
      executor.execute(
        "test-plans/launch-clock-app.yaml",
        emptyMap(),
        AutoMobilePlanExecutionOptions(),
      )

    assertFalse(result.success)
    assertFalse(result.aiRecoveryAttempted)
    assertEquals(1, daemon.reads.size)
    assertEquals(listOf("setToolEnabled", "executePlan"), daemon.calls.map { it.first })
  }

  @Test
  fun `connectivity adapter forwards liveness and wait timeout to its daemon`() {
    val daemon = FakeDaemon()
    val checker = DefaultDaemonConnectivityChecker(daemon)

    assertTrue(checker.isDaemonAlive())
    daemon.alive = false
    assertFalse(checker.isDaemonAlive())
    assertFalse(checker.waitForDaemon(123L))
    daemon.alive = true
    assertTrue(checker.waitForDaemon(456L))
    assertEquals(2, daemon.aliveChecks)
    assertEquals(listOf(123L, 456L), daemon.waitTimeouts)
    assertTrue(daemon.reads.isEmpty())
    assertTrue(daemon.calls.isEmpty())
  }

  @Test
  fun `daemon recovery provider keeps its injected clock and TTL`() {
    val daemon = FakeDaemon()
    var now = 0L
    val provider = DaemonRecoveryConfigProvider(daemon, cacheTtlMs = 100L, clock = { now })

    assertEquals(9, provider.getMaxRecoveryToolCalls())
    now = 99L
    assertFalse(provider.isRecoveryEnabled())
    assertEquals(1, daemon.reads.size)
    now = 100L
    assertEquals(9, provider.getMaxRecoveryToolCalls())
    assertEquals(2, daemon.reads.size)
  }

  @Test
  fun `default collaborators resolve the global agent lazily without opening a socket`() {
    val cachedAgent = LazyInitializer::class.java.getDeclaredField("_agent")
    cachedAgent.isAccessible = true
    val connections = DaemonSocketClientManager::class.java.getDeclaredField("threadLocalClient")
    connections.isAccessible = true
    val clients = connections.get(DaemonSocketClientManager) as ThreadLocal<*>
    val previousClient = clients.get()

    val collaborators = PlanExecutorCollaborators()

    assertSame(DaemonSocketClientManager, collaborators.daemon)
    assertNull(cachedAgent.get(LazyInitializer))
    val agent = collaborators.agent()
    assertSame(agent, LazyInitializer.getAgent())
    assertSame(agent, LazyInitializer.getAgent(DaemonSocketClientManager))
    assertFalse(AutoMobileAgent.DefaultMCPClient().isConnected())
    assertSame(previousClient, clients.get())
  }

  private object FakeConfig :
    AutoMobileAgent.ConfigProvider by AutoMobileAgent.DefaultConfigProvider() {
    override fun getModelConfig() =
      AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "unused-test-key")

    override fun getMcpServerUrl() = "unused"
  }

  private object FakeDevices : DeviceChecker {
    override fun checkDeviceAvailability() = Unit

    override fun areDevicesAvailable() = true

    override fun getDeviceCount() = 1
  }

  private object FakeHeartbeat : DaemonHeartbeatController {
    override fun startBackground(intervalMs: Long) = Closeable {}

    override fun registerSession(sessionId: String) = Unit

    override fun unregisterSession(sessionId: String) = Unit
  }

  private class ToolCallingFactory : AutoMobileAgent.AIAgentFactory {
    var maxToolCalls: Int? = null
    var toolResult: String? = null

    override fun createAIAgent(config: AutoMobileAgent.ModelConfig): AIAgent<String, String> =
      error("Plan generation is not used")

    override fun createAIAgentWithMCPTools(
      config: AutoMobileAgent.ModelConfig,
      mcpClient: AutoMobileAgent.MCPClient,
      maxToolCalls: Int,
    ): AIAgent<String, String> {
      this.maxToolCalls = maxToolCalls
      toolResult = mcpClient.callTool("observe", emptyMap())
      error("Fake recovery stops before creating an LLM agent")
    }
  }

  private class FakeDaemon(private val recoveryEnabled: Boolean = false) : DaemonToolClient {
    override var sessionUuid = "unused-test-session"
    val reads = mutableListOf<Pair<String, Long>>()
    val calls = mutableListOf<Pair<String, JsonObject>>()
    val toolTimeouts = mutableListOf<Long>()
    var alive = true
    var aliveChecks = 0
    val waitTimeouts = mutableListOf<Long>()

    override fun isAlive(): Boolean {
      aliveChecks++
      return alive
    }

    override fun awaitAlive(timeoutMs: Long): Boolean {
      waitTimeouts += timeoutMs
      return alive
    }

    override fun callDaemonMethod(method: String, params: JsonObject, timeoutMs: Long) =
      DaemonResponse("control", "daemon_response", true)

    override fun callTool(
      toolName: String,
      arguments: JsonObject,
      timeoutMs: Long,
    ): DaemonResponse {
      calls += toolName to arguments
      toolTimeouts += timeoutMs
      if (toolName == "executePlan") {
        return DaemonResponse(
          "plan",
          "mcp_response",
          true,
          JsonObject(
            mapOf(
              "content" to
                JsonArray(
                  listOf(
                    JsonObject(
                      mapOf(
                        "type" to JsonPrimitive("text"),
                        "text" to JsonPrimitive(FAILED_PLAN),
                      ),
                    ),
                  ),
                ),
            ),
          ),
        )
      }
      return DaemonResponse(
        "tool",
        "mcp_response",
        true,
        JsonObject(mapOf("fake" to JsonPrimitive(true))),
      )
    }

    override fun readResource(uri: String, timeoutMs: Long): DaemonResponse {
      reads += uri to timeoutMs
      return DaemonResponse(
        "config",
        "mcp_response",
        true,
        JsonObject(
          mapOf(
            "contents" to
              JsonArray(
                listOf(
                  JsonObject(
                    mapOf(
                      "text" to
                        JsonPrimitive(
                          """{"enabled":$recoveryEnabled,"config":{"maxToolCalls":9}}""",
                        ),
                    ),
                  ),
                ),
              ),
          ),
        ),
      )
    }

    private companion object {
      const val FAILED_PLAN =
        """{"success":false,"sessionHeld":true,"deviceId":"fake-device","failedStep":{"stepIndex":0,"tool":"tapOn","error":"blocked"}}"""
    }
  }
}
