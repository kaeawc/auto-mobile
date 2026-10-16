package dev.jasonpearson.automobile.junit

import ai.koog.agents.core.agent.AIAgent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Before
import org.junit.Test

class AgentDaemonInjectionTest {
  @Before
  fun setUp() {
    LazyInitializer.clear()
  }

  @After
  fun tearDown() {
    LazyInitializer.clear()
  }

  @Test
  fun `recovery reads config and calls a tool through the injected daemon`() {
    val daemon = FakeDaemon()
    val factory = ToolCallingFactory()
    val config =
      object : AutoMobileAgent.ConfigProvider by AutoMobileAgent.DefaultConfigProvider() {
        override fun getModelConfig() =
          AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "unused-test-key")

        override fun getMcpServerUrl() = "unused"
      }
    val agent =
      AutoMobileAgent.forDaemon(
        daemon,
        connectivity = FakeConnectivity(),
        configProvider = config,
        aiAgentFactory = factory,
      )
    assertEquals(emptyList<Pair<String, Long>>(), daemon.reads)
    assertEquals(emptyList<Pair<String, JsonObject>>(), daemon.calls)

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
    assertFalse(agent.recoveryConfigProvider.isRecoveryEnabled())
    assertEquals(1, daemon.reads.size)
  }

  @Test
  fun `custom daemon agents are fresh and do not replace the default cached agent`() {
    val defaultAgent = LazyInitializer.getAgent()
    val daemon = FakeDaemon()
    val collaborators = PlanExecutorCollaborators(daemon = daemon)
    assertEquals(0, daemon.reads.size)
    assertEquals(0, daemon.calls.size)

    val first = collaborators.agent()
    val second = collaborators.agent()

    assertNotSame(first, second)
    assertNotSame(first, LazyInitializer.getAgent(daemon))
    assertSame(defaultAgent, LazyInitializer.getAgent())
    assertEquals(9, first.recoveryConfigProvider.getMaxRecoveryToolCalls())
    assertEquals(9, second.recoveryConfigProvider.getMaxRecoveryToolCalls())
    assertEquals(2, daemon.reads.size)
    assertEquals(0, daemon.calls.size)
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

  private class FakeConnectivity : DaemonConnectivityChecker {
    override fun isDaemonAlive() = true

    override fun waitForDaemon(timeoutMs: Long) = true
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

  private class FakeDaemon : DaemonToolClient {
    override var sessionUuid = "unused-test-session"
    val reads = mutableListOf<Pair<String, Long>>()
    val calls = mutableListOf<Pair<String, JsonObject>>()
    val toolTimeouts = mutableListOf<Long>()

    override fun callTool(
      toolName: String,
      arguments: JsonObject,
      timeoutMs: Long,
    ): DaemonResponse {
      calls += toolName to arguments
      toolTimeouts += timeoutMs
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
                      "text" to JsonPrimitive("""{"enabled":false,"config":{"maxToolCalls":9}}"""),
                    ),
                  ),
                ),
              ),
          ),
        ),
      )
    }
  }
}
