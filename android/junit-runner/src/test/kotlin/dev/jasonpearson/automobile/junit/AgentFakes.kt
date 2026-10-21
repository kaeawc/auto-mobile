package dev.jasonpearson.automobile.junit

import ai.koog.agents.core.agent.AIAgent
import ai.koog.agents.core.agent.config.AIAgentConfig
import ai.koog.agents.core.agent.context.AIAgentContext
import ai.koog.agents.core.agent.session.AIAgentRunSession
import java.io.File

/** Records prompts without constructing a Koog graph or contacting a model provider. */
internal class FakeAIAgent : AIAgent<String, String>() {
  var response = ""
  var failure: RuntimeException? = null
  val prompts = mutableListOf<String>()

  override val id = "fake-agent"
  override val agentConfig: AIAgentConfig
    get() = error("The fake does not construct a Koog graph")

  override suspend fun run(agentInput: String, sessionId: String?): String {
    prompts.add(agentInput)
    failure?.let { throw it }
    return response
  }

  override fun createSession(
    sessionId: String?,
  ): AIAgentRunSession<String, String, out AIAgentContext> =
    error("The fake runs directly without Koog sessions")

  override suspend fun close() = Unit
}

// The Agent prefix distinguishes these reusable fakes from RecoveryLoopTest's private fakes.
internal class FakeAgentConfigProvider : AutoMobileAgent.ConfigProvider {
  var configuredModel =
    AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")
  var maxPlanAgeMs = 3600000L
  var debugMode = false
  var serverUrl = "http://localhost:0"
  var serverUrlFailure: RuntimeException? = null

  override fun getModelConfig() = configuredModel

  override fun getPlanMaxAgeMs() = maxPlanAgeMs

  override fun isDebugMode() = debugMode

  override fun getMcpServerUrl(): String {
    serverUrlFailure?.let { throw it }
    return serverUrl
  }
}

/** In-memory file metadata and writes; no filesystem operations are performed. */
internal class FakeAgentFileSystemOperations : AutoMobileAgent.FileSystemOperations {
  val fileExistence = mutableMapOf<File, Boolean>()
  val lastModified = mutableMapOf<File, Long>()
  val createdDirectories = mutableListOf<File>()
  val existenceChecks = mutableListOf<File>()
  val writes = mutableListOf<Pair<File, String>>()

  override fun createDirectories(dir: File) {
    createdDirectories.add(dir)
  }

  override fun fileExists(file: File): Boolean {
    existenceChecks.add(file)
    return fileExistence[file] ?: false
  }

  override fun writeTextToFile(file: File, content: String) {
    writes.add(file to content)
  }

  override fun getLastModified(file: File) = lastModified[file] ?: 0L
}

internal class FakeAgentAIAgentFactory(private val agent: AIAgent<String, String>) :
  AutoMobileAgent.AIAgentFactory {
  data class RecoveryCall(
    val config: AutoMobileAgent.ModelConfig,
    val mcpClient: AutoMobileAgent.MCPClient,
    val maxToolCalls: Int,
    val rawMcpClient: AutoMobileAgent.MCPClient,
  )

  val planCalls = mutableListOf<AutoMobileAgent.ModelConfig>()
  val recoveryCalls = mutableListOf<RecoveryCall>()

  override fun createAIAgent(config: AutoMobileAgent.ModelConfig): AIAgent<String, String> {
    planCalls.add(config)
    return agent
  }

  override fun createAIAgentWithMCPTools(
    config: AutoMobileAgent.ModelConfig,
    mcpClient: AutoMobileAgent.MCPClient,
    maxToolCalls: Int,
  ): AIAgent<String, String> = createAIAgentWithMCPTools(config, mcpClient, maxToolCalls, mcpClient)

  override fun createAIAgentWithMCPTools(
    config: AutoMobileAgent.ModelConfig,
    mcpClient: AutoMobileAgent.MCPClient,
    maxToolCalls: Int,
    rawMcpClient: AutoMobileAgent.MCPClient,
  ): AIAgent<String, String> {
    recoveryCalls.add(RecoveryCall(config, mcpClient, maxToolCalls, rawMcpClient))
    return agent
  }
}

/** Scripted instants repeat the last value, matching a constant clock after the script ends. */
internal class FakeAgentTimeProvider : AutoMobileAgent.TimeProvider {
  var times = ArrayDeque(listOf(0L))

  override fun currentTimeMillis(): Long =
    if (times.size > 1) times.removeFirst() else times.first()
}

internal class FakeAgentMCPClient : AutoMobileAgent.MCPClient {
  var connected = false
  var connectFailure: RuntimeException? = null
  val connectionUrls = mutableListOf<String>()
  var disconnectCalls = 0
    private set

  val toolResults = mutableMapOf<String, String>()
  val toolFailures = mutableMapOf<String, RuntimeException>()
  val toolCalls = mutableListOf<Pair<String, Map<String, Any>>>()

  override fun isConnected() = connected

  override fun connect(serverUrl: String) {
    connectionUrls.add(serverUrl)
    connectFailure?.let { throw it }
    connected = true
  }

  override fun disconnect() {
    disconnectCalls++
    connected = false
  }

  override fun callTool(toolName: String, parameters: Map<String, Any>): String {
    toolCalls.add(toolName to parameters.toMap())
    toolFailures[toolName]?.let { throw it }
    return toolResults[toolName] ?: "{}"
  }

  override fun listAvailableTools() = emptyList<AutoMobileAgent.MCPToolDefinition>()
}
