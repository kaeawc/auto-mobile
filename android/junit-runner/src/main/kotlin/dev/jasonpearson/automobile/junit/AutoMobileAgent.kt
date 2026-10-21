package dev.jasonpearson.automobile.junit

import ai.koog.agents.core.agent.AIAgent
import ai.koog.agents.core.tools.SimpleTool
import ai.koog.serialization.typeToken
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/**
 * Handles AI agent loop functionality for AutoMobile test execution using Koog framework.
 *
 * This class manages AI-powered plan generation from prompts and AI-assisted failure recovery using
 * the AutoMobile MCP server with support for OpenAI, Anthropic, and Google models.
 */
open class AutoMobileAgent(
  private val configProvider: ConfigProvider = DefaultConfigProvider(),
  private val fileSystemOperations: FileSystemOperations = DefaultFileSystemOperations(),
  private val aiAgentFactory: AIAgentFactory = DefaultAIAgentFactory(),
  private val timeProvider: TimeProvider = DefaultTimeProvider(),
  private val mcpClient: MCPClient = DefaultMCPClient(),
  internal val recoveryConfigProvider: RecoveryConfigProvider = DaemonRecoveryConfigProvider(),
) {

  companion object {
    /** Construct both daemon-backed collaborators together without opening a connection. */
    internal fun forDaemon(
      daemon: DaemonToolClient,
      connectivity: DaemonConnectivityChecker = DefaultDaemonConnectivityChecker(daemon),
      configProvider: ConfigProvider = DefaultConfigProvider(),
      aiAgentFactory: AIAgentFactory = DefaultAIAgentFactory(),
    ): AutoMobileAgent =
      AutoMobileAgent(
        configProvider = configProvider,
        aiAgentFactory = aiAgentFactory,
        mcpClient = DefaultMCPClient(daemon, connectivity),
        recoveryConfigProvider = DaemonRecoveryConfigProvider(daemon),
      )
  }

  /** Supported AI model providers */
  enum class ModelProvider {
    OPENAI,
    ANTHROPIC,
    GOOGLE,
  }

  /** Configuration for AI model selection */
  data class ModelConfig(
    val provider: ModelProvider,
    val apiKey: String,
    val proxyEndpoint: String? = null,
  )

  /** Generates a YAML test plan from a prompt using AI agent via Koog framework. */
  fun generatePlanFromPrompt(
    prompt: String,
    className: String,
    methodName: String,
    testResourcesDir: File,
  ): String {
    val generatedPlanName = "${className}_${methodName}.yaml"
    val generatedPlanPath = "test-plans/generated/$generatedPlanName"

    // Create the generated plans directory if it doesn't exist
    val generatedPlansDir = File(testResourcesDir, "test-plans/generated")

    fileSystemOperations.createDirectories(generatedPlansDir)

    val generatedPlanFile = File(generatedPlansDir, generatedPlanName)

    // Check if plan already exists and is recent
    if (
      fileSystemOperations.fileExists(generatedPlanFile) && !shouldRegeneratePlan(generatedPlanFile)
    ) {
      println("Using existing generated plan: $generatedPlanPath")
      return generatedPlanPath
    }

    println("Generating YAML plan from prompt for test: ${className}.${methodName}")
    println("Prompt: $prompt")

    try {
      val planContent = generatePlanContent(prompt, className, methodName)
      fileSystemOperations.writeTextToFile(generatedPlanFile, planContent)
      println("Generated plan saved to: ${generatedPlanFile.absolutePath}")
      return generatedPlanPath
    } catch (e: Exception) {
      throw IllegalStateException("Failed to generate YAML plan from prompt: ${e.message}", e)
    }
  }

  /**
   * Attempts AI-assisted recovery for a failed test step using AutoMobile MCP tools.
   *
   * The agent receives structured context about the failure and uses MCP tools to clear whatever
   * interrupted the failed step (a modal, notification, permission dialog, etc.). After the agent
   * finishes, we call observe ourselves (outside the tool budget) as a device-liveness gate: a
   * non-null result means the device is still responsive and worth resuming on. The authoritative
   * check that recovery actually worked is the caller re-running the failed step (see
   * [PlanExecutor]) — if the obstruction is gone that step now passes.
   */
  /**
   * Backwards-compatible one-argument recovery hook (the pre-#6094 signature). Kept as an explicit
   * `open` delegating method rather than relying on a Kotlin default or `@JvmOverloads` (which
   * would emit the one-arg overload as `final`), so a published-library subclass that overrode the
   * original still compiles and links, and callers compiled against the one-arg descriptor keep
   * working.
   */
  open fun attemptAiRecovery(context: FailedStepContext): RecoveryOutcome =
    attemptAiRecovery(context, emptyList())

  open fun attemptAiRecovery(
    context: FailedStepContext,
    secretValues: List<String>,
  ): RecoveryOutcome =
    attemptAiRecovery(context, secretValues, PlanExecutorTimings(), DaemonHeartbeat)

  /**
   * Recovery uses the same held-device wait and heartbeat owner as its executor. The executor calls
   * this overload, so overriding only the two-argument [attemptAiRecovery] is not honoured by it.
   */
  internal open fun attemptAiRecovery(
    context: FailedStepContext,
    secretValues: List<String>,
    timings: PlanExecutorTimings,
    heartbeat: DaemonHeartbeatController,
  ): RecoveryOutcome {
    val startTime = timeProvider.currentTimeMillis()
    val maxToolCalls = recoveryConfigProvider.getMaxRecoveryToolCalls()

    try {
      // Initialize MCP connection
      val mcpServerUrl = configProvider.getMcpServerUrl()
      if (!mcpClient.isConnected()) {
        mcpClient.connect(mcpServerUrl)
      }

      val modelConfig = configProvider.getModelConfig()
      // Second-order redaction (issue #6094): the Koog agent loop feeds every tool/observe RESULT
      // (including the view hierarchy from observe's `withViewHierarchy = true`) back to the LLM
      // provider. Wrap the client the agent's tools call in a redactor so those result strings are
      // scrubbed of secret values before they reach the model. The tool still EXECUTES on-device
      // with the real values (the decorator forwards arguments unchanged). The initial recovery
      // prompt is already redacted by the executor (#6092); this closes the loop channel. With no
      // secrets the raw client is used unchanged (no wrapper allocated).
      //
      // #6145 fix: the wrapper also redacts the intermediate observe result that the composite
      // WaitForTool searches locally. Its own output to the model is synthesized ("found" /
      // "timeout") and never leaks that observe text, so redacting the copy it searches only
      // produces a false timeout when the wait target is a substring of an on-screen secret value
      // — it buys no security. So WaitForTool is wired to the RAW (unredacted-on-success) client
      // below via createAIAgentWithMCPTools's rawMcpClient param, while every pass-through tool
      // (whose result DOES reach the model) keeps using agentMcpClient, the redacting wrapper.
      //
      // #6145 follow-up: a FAILED observe call bypasses that "never leaks" argument —
      // DefaultMCPClient
      // throws with the server's response body / error in the message, which can echo on-screen
      // data,
      // and WaitForTool logs it on every failed poll. rawMcpClient is wrapped in
      // FailureRedactingMCPClient so a successful result still reaches WaitForTool byte-for-byte
      // unredacted (the local match keeps working), while a thrown exception's message is redacted
      // before WaitForTool can log or surface it.
      //
      // Normalize the incoming concrete secret values into every scrub form (NFC/NFD + the
      // transport-encoding depths) HERE, at the public recovery entry point, so the loop is safe
      // whether a caller passed raw or pre-expanded values: this is a public overload, so a direct
      // caller could pass raw concrete secrets, and matching only those would miss the escaped
      // representation in JSON tool results. Idempotent for the executor's already-expanded input.
      val redactionValues = SecretRedactor.secretValues(secretValues)
      // Every recovery call — the agent's tools, WaitForTool and the liveness observe — targets
      // the device the failed step ran on, not whichever device the daemon defaults to (#10089).
      val deviceClient = recoveryDeviceClient(context, heartbeat, timings)
      val agentMcpClient =
        if (redactionValues.isEmpty()) deviceClient
        else RedactingMCPClient(deviceClient, redactionValues)
      val waitForRawMcpClient =
        if (redactionValues.isEmpty()) deviceClient
        else FailureRedactingMCPClient(deviceClient, redactionValues)
      val aiAgent =
        aiAgentFactory.createAIAgentWithMCPTools(
          modelConfig,
          agentMcpClient,
          maxToolCalls,
          waitForRawMcpClient,
        )

      // Redact the STATIC context fields that go into the initial prompt too (#6094). The executor
      // already redacts these on the FailedStepContext (#6092), so this is a no-op for that path;
      // it
      // makes the public entry point self-contained, so a direct caller who supplies raw context
      // fields alongside raw secretValues cannot leak them in the first ModelRequest. Redacting an
      // already-redacted field changes nothing.
      val recoveryPrompt = recoveryPrompt(context, redactionValues, maxToolCalls)

      return runRecoveryAgent(
        aiAgent,
        recoveryPrompt,
        RecoveryVerification(context, deviceClient, redactionValues, startTime),
      )
    } catch (e: Exception) {
      // Loud, actionable and on stderr: recovery is on by default outside CI, so a missing daemon
      // or model API key must not look like "recovery ran and found nothing" (#10089).
      System.err.println(
        "AI-assisted recovery could not start: ${e.message}. " +
          "The failed step is reported as a plain failure. Make sure the AutoMobile daemon " +
          "is running and a model API key is configured, or disable AI assistance.",
      )
    } finally {
      try {
        mcpClient.disconnect()
      } catch (e: Exception) {
        println("Warning: Failed to cleanly disconnect MCP client: ${e.message}")
      }
    }

    val recoveryTime = timeProvider.currentTimeMillis() - startTime
    return RecoveryOutcome(false, recoveryTime)
  }

  private data class RecoveryVerification(
    val context: FailedStepContext,
    val deviceClient: MCPClient,
    val redactionValues: List<String>,
    val startTime: Long,
  )

  private fun runRecoveryAgent(
    aiAgent: ai.koog.agents.core.agent.AIAgent<String, String>,
    recoveryPrompt: String,
    verification: RecoveryVerification,
  ): RecoveryOutcome {
    val (context, deviceClient, redactionValues, startTime) = verification
    return runBlocking {
      try {
        println(
          "Starting AI recovery for step ${context.failedStepIndex + 1} (${context.failedTool})...",
        )

        aiAgent.run(recoveryPrompt)

        println("AI recovery agent finished, verifying device state...")

        // Device-liveness gate: confirm the device is still responsive before the caller
        // spends a daemon round-trip re-running the failed step. This is NOT proof the
        // interruption is gone — the failed-step re-run in the executor is that check.
        val observeResult =
          try {
            // Scrub the post-recovery liveness observe too (issue #6094): its view hierarchy can
            // carry an on-screen secret, and it is surfaced on the RecoveryOutcome. The device is
            // still queried with real values — only the returned text is redacted.
            SecretRedactor.redact(deviceClient.callTool("observe", emptyMap()), redactionValues)
          } catch (e: Exception) {
            println("Warning: Post-recovery observe failed: ${e.message}")
            null
          }

        val recoveryTime = timeProvider.currentTimeMillis() - startTime
        RecoveryOutcome(
          success = observeResult != null && !isToolErrorResult(observeResult),
          recoveryTimeMs = recoveryTime,
          observeResultAfterRecovery = observeResult,
        )
      } catch (e: Exception) {
        println("AI recovery execution failed: ${e.message}")
        val recoveryTime = timeProvider.currentTimeMillis() - startTime
        RecoveryOutcome(false, recoveryTime)
      }
    }
  }

  private fun recoveryDeviceClient(
    context: FailedStepContext,
    heartbeat: DaemonHeartbeatController,
    timings: PlanExecutorTimings,
  ): MCPClient {
    val pinnedClient =
      DevicePinningMCPClient.pinTo(mcpClient, context.deviceId, context.sessionUuid)
    // Recovery that holds the failed attempt's session waits, bounded, for its device if the
    // idle window released it during a long think (#10979).
    // A held session the daemon released mid-recovery fails every later call at once with the
    // daemon's reason instead of driving a device the runner no longer holds (#11072).
    return if (context.sessionUuid.isNullOrBlank()) pinnedClient
    else
      HeldDeviceWaitingMCPClient(
        SessionLossGuardMCPClient(pinnedClient, context.sessionUuid, heartbeat::sessionLoss),
        backoffDelayMs = { waits, waited, retryAfterMs, code ->
          DeviceWaitPolicy.deviceOwnedBackoffDelayMs(
            waits,
            waited,
            retryAfterMs,
            code,
            timings,
          )
        },
        sleeper = timings.deviceOwnedSleeper,
      )
  }

  private fun recoveryPrompt(
    context: FailedStepContext,
    redactionValues: List<String>,
    maxToolCalls: Int,
  ): String {
    val redactedFailedTool = SecretRedactor.redact(context.failedTool, redactionValues)
    val redactedError = SecretRedactor.redact(context.error, redactionValues)
    val redactedPlanContent = SecretRedactor.redact(context.planContent, redactionValues)
    val succeededStepsSummary =
      if (context.succeededSteps.isEmpty()) {
        "  (none — the first step failed)"
      } else {
        context.succeededSteps.joinToString("\n") { step ->
          "  - Step ${step.stepIndex + 1}: ${SecretRedactor.redact(step.tool, redactionValues)} (completed)"
        }
      }

    return """
        A test plan step was interrupted and failed. Your job is to CLEAR whatever is
        blocking the app — you do NOT need to perform the failed step yourself.

        FAILED STEP: Step ${context.failedStepIndex + 1} using tool "$redactedFailedTool"
        ERROR: $redactedError

        PREVIOUSLY SUCCEEDED STEPS:
        $succeededStepsSummary

        PLAN YAML:
        $redactedPlanContent

        After you finish, the test runner will AUTOMATICALLY RE-RUN the failed step
        (step ${context.failedStepIndex + 1}) and then continue with the rest of the plan.
        So do NOT tap the failed step's own target or otherwise perform its action — just
        remove whatever is blocking it and leave the app on the screen that step expects.

        You have a maximum of $maxToolCalls tool calls.

        Instructions:
        1. Call observe to see the current device state.
        2. Identify anything blocking the failed step and dismiss it, for example:
           - a system notification or the expanded notification shade
           - a permission dialog (accept or deny as the plan implies)
           - a modal, popup, bottom sheet, or interstitial
           - an ANR ("isn't responding") or crash ("has stopped") dialog
           Dismiss it with its close / OK / allow / deny affordance, or press Back.
        3. Return the app to the screen the failed step expects, then stop.

        Do NOT perform the failed step's action — the runner retries it for you.
      """
      .trimIndent()
  }

  private fun shouldRegeneratePlan(planFile: File): Boolean {
    // Regenerate if file is older than 1 hour (configurable via system property)
    val maxAgeMs = configProvider.getPlanMaxAgeMs()
    val fileAge = timeProvider.currentTimeMillis() - fileSystemOperations.getLastModified(planFile)
    return fileAge > maxAgeMs
  }

  private fun generatePlanContent(prompt: String, className: String, methodName: String): String {
    println("Generating plan content using Koog AI agent...")

    try {
      val modelConfig = configProvider.getModelConfig()
      val aiAgent = aiAgentFactory.createAIAgent(modelConfig)

      val planGenerationPrompt = planGenerationPrompt(prompt, className, methodName)

      return runBlocking {
        try {
          val response = aiAgent.run(planGenerationPrompt)

          // Extract YAML content from the response
          val yamlContent = extractYamlFromResponse(response)

          if (yamlContent.isEmpty()) {
            throw IllegalStateException("AI agent generated empty YAML content")
          }

          val debugMode = configProvider.isDebugMode()
          if (debugMode) {
            println("AI agent generated plan:\n$yamlContent")
          }

          yamlContent
        } catch (e: Exception) {
          throw IllegalStateException("Plan generation via AI agent failed: ${e.message}", e)
        }
      }
    } catch (e: Exception) {
      throw IllegalStateException(
        "Failed to initialize AI agent for plan generation: ${e.message}",
        e,
      )
    }
  }

  private fun planGenerationPrompt(prompt: String, className: String, methodName: String): String =
    """
        Generate an AutoMobile YAML test plan for the following requirement:

        Test Class: $className
        Test Method: $methodName
        User Request: $prompt

        Create a comprehensive YAML plan that includes:
        1. A descriptive name and description
        2. Step-by-step actions using AutoMobile tools like:
           - observe (to check device state)
           - tapOn (to tap elements by text or coordinates)
           - typeText (to enter text)
           - swipe (for scrolling)
           - waitFor (for timing)

        Follow this YAML structure:
        ---
        name: descriptive-test-name
        description: Clear description of what the test does
        steps:
          - tool: observe
            withViewHierarchy: true
            label: Initial observation
          - tool: tapOn
            text: "element text"
            label: Tap on specific element
          # Add more steps as needed

        Make the plan specific and actionable for mobile automation.
      """
      .trimIndent()

  private fun extractYamlFromResponse(response: String?): String {
    if (response.isNullOrBlank()) return ""
    // Look for YAML content between ```yaml and ``` or ```yml and ```
    val yamlRegex = """```ya?ml\s*\n(.*?)\n```""".toRegex(RegexOption.DOT_MATCHES_ALL)
    val match = yamlRegex.find(response)

    return if (match != null) {
      match.groupValues[1].trim()
    } else {
      // If no code blocks found, look for content starting with ---
      val lines = response.lines()
      val yamlStartIndex = lines.indexOfFirst { it.trim().startsWith("---") }

      if (yamlStartIndex != -1) {
        lines.drop(yamlStartIndex).joinToString("\n").trim()
      } else {
        // Fallback: return the entire response if it looks like YAML
        if (response.contains("name:") && response.contains("steps:")) {
          response.trim()
        } else {
          ""
        }
      }
    }
  }

  // MCP Client interface and implementation
  interface MCPClient {
    fun isConnected(): Boolean

    fun connect(serverUrl: String)

    fun disconnect()

    fun callTool(toolName: String, parameters: Map<String, Any>): String

    fun listAvailableTools(): List<MCPToolDefinition>
  }

  @Serializable data class MCPRequest(val method: String, val params: JsonObject)

  @Serializable
  data class MCPResponse(val result: JsonElement? = null, val error: JsonElement? = null)

  @Serializable
  data class MCPToolDefinition(
    val name: String,
    val description: String,
    val inputSchema: JsonElement,
  )

  @Serializable data class MCPListToolsResponse(val tools: List<MCPToolDefinition>)

  /**
   * Default [MCPClient]: routes every call through [DaemonSocketClientManager], the same daemon
   * socket transport `executePlan` uses (#10089). It previously ran its own HTTP client against
   * `/health` and `/mcp`, neither of which the daemon serves (it serves `/heartbeat` and
   * `/auto-mobile/streamable` only), so recovery could never make a single tool call.
   *
   * The `serverUrl` handed to [connect] is ignored: the daemon is located through the socket paths
   * the runner already resolved. An `isError: true` tool result is thrown, not returned, so neither
   * the model nor the post-recovery liveness gate can mistake a rejected call for a live device.
   */
  class DefaultMCPClient
  internal constructor(
    private val daemon: DaemonToolCaller,
    private val connectivity: DaemonConnectivityChecker,
  ) : MCPClient {
    constructor() : this(DaemonSocketClientManager)

    internal constructor(
      daemon: DaemonToolClient,
      connectivity: DaemonConnectivityChecker = DefaultDaemonConnectivityChecker(daemon),
    ) : this(DaemonToolCaller(daemon::callTool), connectivity)

    @Volatile private var connected = false
    private val koogJson = Json { ignoreUnknownKeys = true }

    override fun isConnected(): Boolean = connected && connectivity.isDaemonAlive()

    override fun connect(serverUrl: String) {
      if (!connectivity.isDaemonAlive()) {
        throw IllegalStateException(
          "AutoMobile daemon is not reachable on its socket; AI recovery runs through the " +
            "same daemon as the plan (the configured MCP url $serverUrl is not used)",
        )
      }
      connected = true
      println("Connected to the AutoMobile daemon for AI recovery")
    }

    override fun disconnect() {
      connected = false
    }

    override fun callTool(toolName: String, parameters: Map<String, Any>): String {
      check(connected) { "MCP client not connected" }
      val response =
        try {
          val timeoutMs =
            when (toolName) {
              "observe",
              "launchApp" -> OBSERVE_LAUNCH_TIMEOUT_MS
              else -> TOOL_CALL_TIMEOUT_MS
            }
          daemon.call(toolName, buildJsonParameters(parameters), timeoutMs)
        } catch (e: Exception) {
          throw IllegalStateException("Failed to call MCP tool $toolName: ${e.message}", e)
        }
      if (!response.success) {
        throw IllegalStateException(
          "Failed to call MCP tool $toolName: ${response.error ?: "daemon returned failure"}",
        )
      }
      val result = response.result ?: return ""
      val resultText = result.toString()
      if (isToolErrorResult(resultText)) {
        throw IllegalStateException(
          "MCP tool $toolName returned an error: ${toolResultText(result)}",
        )
      }
      return resultText
    }

    /**
     * Tool discovery is not exposed over the daemon socket. The agent's tool surface is fixed and
     * pinned to `schemas/tool-definitions.json` by `RecoveryToolContractTest`.
     */
    override fun listAvailableTools(): List<MCPToolDefinition> =
      throw UnsupportedOperationException(
        "Tool discovery is not available over the daemon socket; the recovery tool surface is fixed",
      )

    /**
     * Parse a tools/list MCP response. A well-formed response with no `error` but a null/absent
     * `result` previously hit `result!!` and produced a misleading `... null` NPE; report an
     * actionable message instead (#3607).
     */
    internal fun parseListToolsResponse(mcpResponse: MCPResponse): List<MCPToolDefinition> {
      if (mcpResponse.error != null) {
        throw IllegalStateException("MCP server error: ${mcpResponse.error}")
      }
      val result =
        mcpResponse.result ?: throw IllegalStateException("MCP tools/list returned no result")
      return koogJson.decodeFromString<MCPListToolsResponse>(result.toString()).tools
    }

    private fun buildJsonParameters(parameters: Map<String, Any>): JsonObject = buildJsonObject {
      parameters.forEach { (key, value) -> put(key, toJsonElement(value)) }
    }

    private companion object {
      const val TOOL_CALL_TIMEOUT_MS = 30_000L
      // keep in sync with the observe/openLink floor in src/daemon/mcpRequestTimeout.ts
      const val OBSERVE_LAUNCH_TIMEOUT_MS = 90_000L
    }
  }

  /** Seam over [DaemonSocketClientManager.callTool] so the client is testable without a daemon. */
  internal fun interface DaemonToolCaller {
    fun call(toolName: String, arguments: JsonObject, timeoutMs: Long): DaemonResponse
  }

  // Class-based AutoMobile MCP Tools (no reflection required)
  // These tools use Koog's SimpleTool pattern for Robolectric compatibility

  /** Observe the current device state and UI hierarchy */
  class ObserveTool(private val mcpClient: MCPClient) :
    SimpleTool<ObserveTool.Args>(
      argsType = typeToken<Args>(),
      name = "observe",
      description =
        "Observe the current device state and UI elements; set raw=true for the full raw view hierarchy",
    ) {

    @Serializable data class Args(val raw: Boolean = false)

    override suspend fun execute(args: Args): String {
      val parameters = if (args.raw) mapOf<String, Any>("raw" to true) else emptyMap()
      return mcpClient.callTool("observe", parameters)
    }
  }

  /** Tap an element by text or id, or tap at screen coordinates */
  class TapOnTool(private val mcpClient: MCPClient) :
    SimpleTool<TapOnTool.Args>(
      argsType = typeToken<Args>(),
      name = "tapOn",
      description =
        "Tap an element by text or id (id wins when both are given), or at screen coordinates (x and y). " +
          "action is tap (default), doubleTap, or longPress",
    ) {

    @Serializable
    data class Args(
      val text: String? = null,
      val id: String? = null,
      val x: Int? = null,
      val y: Int? = null,
      val action: String = "tap",
    )

    override suspend fun execute(args: Args): String =
      callElementOrCoordinateTap(
        mcpClient,
        TapTarget(args.text, args.id, args.x, args.y),
        args.action,
      )
  }

  /** Enter text into the focused input field */
  class TypeTextTool(private val mcpClient: MCPClient) :
    SimpleTool<TypeTextTool.Args>(
      argsType = typeToken<Args>(),
      name = "typeText",
      description = "Enter text into the focused input field",
    ) {

    @Serializable data class Args(val text: String)

    override suspend fun execute(args: Args): String {
      val command = buildJsonObject {
        put("action", JsonPrimitive("type"))
        put("text", JsonPrimitive(args.text))
      }
      return mcpClient.callTool("sendKeys", mapOf("commands" to JsonArray(listOf(command))))
    }
  }

  /** Type, clear, or submit text through the canonical text-input tool. */
  class SendKeysTool(private val mcpClient: MCPClient) :
    SimpleTool<SendKeysTool.Args>(
      argsType = typeToken<Args>(),
      name = "sendKeys",
      description = "Type, clear, or submit text in the focused input field",
    ) {

    @Serializable
    data class Args(
      val action: String = "type",
      val text: String? = null,
      val key: String? = null,
    )

    override suspend fun execute(args: Args): String {
      val command =
        when (args.action) {
          "type" ->
            buildJsonObject {
              put("action", JsonPrimitive("type"))
              put("text", JsonPrimitive(requireNotNull(args.text) { "text is required for type" }))
              put("operation", JsonPrimitive("replace"))
            }
          "clear" -> buildJsonObject { put("action", JsonPrimitive("clear")) }
          "key" ->
            buildJsonObject {
              put("action", JsonPrimitive("key"))
              put("key", JsonPrimitive(requireNotNull(args.key) { "key is required for key" }))
            }
          else -> throw IllegalArgumentException("action must be type, clear, or key")
        }
      return mcpClient.callTool("sendKeys", mapOf("commands" to JsonArray(listOf(command))))
    }
  }

  /** Perform swipe gestures for scrolling or navigation */
  class SwipeTool(private val mcpClient: MCPClient) :
    SimpleTool<SwipeTool.Args>(
      argsType = typeToken<Args>(),
      name = "swipe",
      description = "Perform swipe gestures for scrolling or navigation",
    ) {

    @Serializable
    data class Args(val direction: String = "up", val containerElementId: String? = null)

    override suspend fun execute(args: Args): String {
      val parameters = mutableMapOf<String, Any>("direction" to args.direction)
      if (args.containerElementId != null) {
        parameters["container"] = mapOf("elementId" to args.containerElementId)
      } else {
        parameters["includeSystemInsets"] = false
      }
      return mcpClient.callTool("swipeOn", parameters)
    }
  }

  /** Scroll within a container element */
  class ScrollTool(private val mcpClient: MCPClient) :
    SimpleTool<ScrollTool.Args>(
      argsType = typeToken<Args>(),
      name = "scroll",
      description =
        "Scroll within a container element, optionally until a text or element id (id wins) is visible",
    ) {

    @Serializable
    data class Args(
      val containerElementId: String,
      val direction: String = "up",
      val lookForText: String? = null,
      val lookForElementId: String? = null,
    )

    override suspend fun execute(args: Args): String {
      val parameters =
        mutableMapOf<String, Any>(
          "direction" to args.direction,
          "gestureType" to "scrollTowardsDirection",
          "container" to mapOf("elementId" to args.containerElementId),
        )
      when {
        args.lookForElementId != null ->
          parameters["lookFor"] = mapOf("elementId" to args.lookForElementId)
        args.lookForText != null -> parameters["lookFor"] = mapOf("text" to args.lookForText)
      }
      return mcpClient.callTool("swipeOn", parameters)
    }
  }

  /**
   * Wait for elements to appear or conditions to be met.
   *
   * A composite tool: unlike the pass-through tools above, its RESULT to the model is a synthesized
   * "found"/"timeout" string, never the observe text it searches. So [AutoMobileMCPToolFactory]
   * wires this to a client that is RAW (unredacted) on a successful call — searching a redacted
   * copy would falsely time out whenever the wait target is a substring of an on-screen secret
   * value, with no security benefit (issue #6145; the intermediate observe text itself never
   * reaches the model through this tool). During recovery that client is
   * [FailureRedactingMCPClient], which still redacts a thrown exception's message — a FAILED
   * observe call's error content is a different leak channel this tool logs on every failed poll
   * attempt, unlike the synthesized success result.
   */
  class WaitForTool(private val mcpClient: MCPClient) :
    SimpleTool<WaitForTool.Args>(
      argsType = typeToken<Args>(),
      name = "waitFor",
      description = "Wait for elements to appear or conditions to be met",
    ) {

    private var clock: TimeProvider = DefaultTimeProvider()
    private var pause: suspend (Long) -> Unit = { kotlinx.coroutines.delay(it) }

    internal constructor(
      mcpClient: MCPClient,
      clock: TimeProvider,
      pause: suspend (Long) -> Unit,
    ) : this(mcpClient) {
      this.clock = clock
      this.pause = pause
    }

    @Serializable
    data class Args(
      val text: String? = null,
      val elementId: String? = null,
      val timeout: Int = 5000,
    )

    override suspend fun execute(args: Args): String {
      // Note: The current MCP server doesn't have a dedicated waitFor tool
      // We'll simulate it by repeatedly calling observe until the element is found
      val startTime = clock.currentTimeMillis()
      val endTime = startTime + args.timeout

      while (clock.currentTimeMillis() < endTime) {
        try {
          val observeResult = mcpClient.callTool("observe", mapOf("project" to "full"))

          // Check if the element we're waiting for is present
          if (args.text != null && observeResult.contains(args.text, ignoreCase = true)) {
            return "Element with text '${args.text}' found"
          }

          if (args.elementId != null && observeResult.contains(args.elementId)) {
            return "Element with ID '${args.elementId}' found"
          }
        } catch (e: Exception) {
          // Log instead of swallowing; keep polling after a transient observe failure.
          println("Warning: waitFor observe failed, will retry: ${e.message}")
        }

        // Pace between attempts on BOTH the no-match and error paths. Previously the
        // sleep sat inside the try above the throw, so a throwing observe skipped it
        // and the loop busy-spun the daemon for the whole timeout window (#3606).
        // A successful match returns from inside the try and never reaches here.
        pause(500)
      }

      val target = args.text ?: args.elementId ?: "unknown"
      throw IllegalStateException("Timeout waiting for element: $target")
    }
  }

  /** Navigate back in the app using the back button */
  class GoBackTool(private val mcpClient: MCPClient) :
    SimpleTool<GoBackTool.Args>(
      argsType = typeToken<Args>(),
      name = "goBack",
      description = "Navigate back in the app using the back button",
    ) {

    @Serializable class Args

    override suspend fun execute(args: Args): String {
      val parameters = mapOf("button" to "back")
      return mcpClient.callTool("pressButton", parameters)
    }
  }

  /** Press a hardware button */
  class PressButtonTool(private val mcpClient: MCPClient) :
    SimpleTool<PressButtonTool.Args>(
      argsType = typeToken<Args>(),
      name = "pressButton",
      description = "Press a hardware button",
    ) {

    @Serializable data class Args(val button: String)

    override suspend fun execute(args: Args): String {
      val parameters = mapOf("button" to args.button)
      return mcpClient.callTool("pressButton", parameters)
    }
  }

  /** Launch an app by package ID */
  class LaunchAppTool(private val mcpClient: MCPClient) :
    SimpleTool<LaunchAppTool.Args>(
      argsType = typeToken<Args>(),
      name = "launchApp",
      description = "Launch an app by package ID",
    ) {

    @Serializable data class Args(val appId: String)

    override suspend fun execute(args: Args): String {
      val parameters = mapOf("appId" to args.appId)
      return mcpClient.callTool("launchApp", parameters)
    }
  }

  /** Terminate an app by package ID */
  class TerminateAppTool(private val mcpClient: MCPClient) :
    SimpleTool<TerminateAppTool.Args>(
      argsType = typeToken<Args>(),
      name = "terminateApp",
      description = "Terminate an app by package ID",
    ) {

    @Serializable data class Args(val appId: String)

    override suspend fun execute(args: Args): String {
      val parameters = mapOf("appId" to args.appId)
      return mcpClient.callTool("terminateApp", parameters)
    }
  }

  /** Double tap on coordinates */
  class DoubleTapOnTool(private val mcpClient: MCPClient) :
    SimpleTool<DoubleTapOnTool.Args>(
      argsType = typeToken<Args>(),
      name = "doubleTapOn",
      description = "Double tap on coordinates",
    ) {

    @Serializable data class Args(val x: Int, val y: Int)

    override suspend fun execute(args: Args): String =
      mcpClient.callTool("tapAt", mapOf("x" to args.x, "y" to args.y, "action" to "doubleTap"))
  }

  /** Long press on coordinates or elements */
  class LongPressOnTool(private val mcpClient: MCPClient) :
    SimpleTool<LongPressOnTool.Args>(
      argsType = typeToken<Args>(),
      name = "longPressOn",
      description = "Long press on an element (text or id) or on coordinates",
    ) {

    @Serializable
    data class Args(
      val text: String? = null,
      val id: String? = null,
      val x: Int? = null,
      val y: Int? = null,
      val duration: Int = 1000,
    )

    override suspend fun execute(args: Args): String =
      callElementOrCoordinateTap(
        mcpClient,
        TapTarget(args.text, args.id, args.x, args.y),
        action = "longPress",
        durationMs = args.duration,
      )
  }

  /**
   * Helper to create all MCP tools for an agent.
   *
   * [mcpClient] backs every pass-through tool (its result reaches the model, so during recovery
   * this is the redacting wrapper). [rawMcpClient] backs [WaitForTool] alone — a composite tool
   * whose model-facing result is a synthesized string, so redacting the observe text it searches
   * locally only produces false timeouts, not a leak (issue #6145) — though a FAILED call is still
   * redacted before it can be logged (see [FailureRedactingMCPClient]). Defaults to [mcpClient] so
   * non-recovery callers (no secrets, no wrapper) are unaffected.
   *
   * `@JvmOverloads` on the primary constructor (issue #6145 P2 — binary compatibility): a bare
   * Kotlin default parameter only generates a synthetic mask/marker constructor, not the original
   * one-argument JVM descriptor. Replacing the old `(MCPClient)` constructor with a defaulted
   * two-argument one therefore removed `<init>(MCPClient)V` entirely, breaking already-compiled
   * consumers that call `AutoMobileMCPToolFactory(mcpClient)` directly with `NoSuchMethodError`.
   * `@JvmOverloads` makes Kotlin emit the original one-argument constructor (delegating to the
   * two-argument one with `rawMcpClient` defaulted to [mcpClient], the pre-#6145 behavior) in
   * addition to the two-argument one, so both descriptors exist.
   */
  class AutoMobileMCPToolFactory
  @JvmOverloads
  constructor(
    private val mcpClient: MCPClient,
    private val rawMcpClient: MCPClient = mcpClient,
  ) {
    fun createAllTools(): List<SimpleTool<*>> =
      listOf(
        ObserveTool(mcpClient),
        TapOnTool(mcpClient),
        TypeTextTool(mcpClient),
        SendKeysTool(mcpClient),
        SwipeTool(mcpClient),
        ScrollTool(mcpClient),
        WaitForTool(rawMcpClient),
        GoBackTool(mcpClient),
        PressButtonTool(mcpClient),
        LaunchAppTool(mcpClient),
        TerminateAppTool(mcpClient),
        DoubleTapOnTool(mcpClient),
        LongPressOnTool(mcpClient),
      )
  }

  // Dependency interfaces for better testability
  interface ConfigProvider {
    fun getModelConfig(): ModelConfig

    fun getPlanMaxAgeMs(): Long

    fun isDebugMode(): Boolean

    /**
     * Retained for source and binary compatibility. [DefaultMCPClient] talks to the daemon over its
     * socket and ignores this URL; the daemon serves no `/health` or `/mcp` HTTP endpoint (#10089).
     */
    fun getMcpServerUrl(): String
  }

  interface FileSystemOperations {
    fun createDirectories(dir: File)

    fun fileExists(file: File): Boolean

    fun writeTextToFile(file: File, content: String)

    fun getLastModified(file: File): Long
  }

  interface AIAgentFactory {
    fun createAIAgent(config: ModelConfig): AIAgent<String, String>

    /**
     * The original (pre-#6145) abstract method, kept as its OWN method rather than folded into the
     * 4-arg overload below via a defaulted `rawMcpClient` parameter (issue #6145 P2 — binary
     * compatibility). A Kotlin default parameter value is resolved at the CALL SITE from the
     * declaration visible to the compiler; it is not something an implementing class provides, so
     * it does nothing to preserve what an implementor's `.class` actually links against. Adding
     * `rawMcpClient` as a 4th defaulted parameter directly on this method (the #6145 mistake)
     * silently replaced the 3-arg abstract method the interface published with a 4-arg one — any
     * external [AIAgentFactory] implementer compiled against the old 3-arg descriptor would stop
     * satisfying the interface (`AbstractMethodError` at link time), because their `.class` only
     * ever contained a 3-arg method.
     */
    fun createAIAgentWithMCPTools(
      config: ModelConfig,
      mcpClient: MCPClient,
      maxToolCalls: Int = 5,
    ): AIAgent<String, String>

    /**
     * New overload (#6145): [rawMcpClient] backs [WaitForTool] with a client that is raw
     * (unredacted) on success while [mcpClient] backs every pass-through tool. Carries a default
     * body — it is NOT abstract — that forwards to the 3-arg method above, discarding the separate
     * raw client (the pre-#6145 behavior: [WaitForTool] shared whatever client every other tool
     * used). That keeps this method optional: an external [AIAgentFactory] implementer that
     * predates #6145 and only overrides the 3-arg method above still compiles and links against
     * this interface without ever knowing this overload exists. [DefaultAIAgentFactory] overrides
     * it directly to route `rawMcpClient` to [WaitForTool] distinctly.
     */
    fun createAIAgentWithMCPTools(
      config: ModelConfig,
      mcpClient: MCPClient,
      maxToolCalls: Int,
      rawMcpClient: MCPClient,
    ): AIAgent<String, String> = createAIAgentWithMCPTools(config, mcpClient, maxToolCalls)
  }

  interface TimeProvider {
    fun currentTimeMillis(): Long
  }

  // Default implementations
  class DefaultConfigProvider : ConfigProvider by EnvironmentConfigProvider()

  class DefaultFileSystemOperations : FileSystemOperations {
    override fun createDirectories(dir: File) {
      if (!dir.exists()) {
        dir.mkdirs()
      }
    }

    override fun fileExists(file: File): Boolean = file.exists()

    override fun writeTextToFile(file: File, content: String) {
      file.writeText(content)
    }

    override fun getLastModified(file: File): Long = file.lastModified()
  }

  class DefaultAIAgentFactory : AIAgentFactory by KoogAIAgentFactory()

  class DefaultTimeProvider : TimeProvider {
    override fun currentTimeMillis(): Long = System.currentTimeMillis()
  }
}

/**
 * Hard iteration ceiling for a recovery agent run, derived from the configured tool-call budget.
 *
 * Koog's `AIAgentConfig.maxAgentIterations` counts every agent step, so making N tool calls takes
 * N + 1 iterations — the extra one is the concluding assistant turn that produces no tool call and
 * ends the loop. We add that +1 of headroom so an agent that spends its full budget still finishes
 * cleanly, while an agent that attempts an (N + 1)th tool call trips the cap (Koog throws, and the
 * caller treats that as a failed recovery). [coerceAtLeast] keeps a misconfigured non-positive
 * budget from yielding a zero or negative cap, which would abort before the agent can even observe.
 */
internal fun recoveryIterationCap(maxToolCalls: Int): Int = maxToolCalls.coerceAtLeast(1) + 1

private data class TapTarget(val text: String?, val id: String?, val x: Int?, val y: Int?)

private val TAP_ACTIONS = setOf("tap", "doubleTap", "longPress")

/**
 * Taps an element (`tapOn` with a `selector`) or a point (`tapAt`), the two real tools behind what
 * the legacy `tapOn`/`longPressOn` agent tools tried to do with one made-up parameter shape
 * (#10089). An element selector wins over coordinates; `id` wins over `text`.
 */
private fun callElementOrCoordinateTap(
  mcpClient: AutoMobileAgent.MCPClient,
  target: TapTarget,
  action: String,
  durationMs: Int? = null,
): String {
  val (text, id, x, y) = target
  require(action in TAP_ACTIONS) { "action must be one of $TAP_ACTIONS" }
  val selector =
    when {
      id != null -> mapOf("elementId" to id)
      text != null -> mapOf("text" to text)
      else -> null
    }
  val parameters = mutableMapOf<String, Any>()
  if (action != "tap") parameters["action"] = action
  if (selector != null) {
    parameters["selector"] = selector
    if (action == "longPress" && durationMs != null) {
      parameters["duration"] = durationMs.coerceIn(0, 60_000)
    }
    return mcpClient.callTool("tapOn", parameters)
  }
  require(x != null && y != null) { "Must specify text, id, or both coordinates (x and y)" }
  parameters["x"] = x
  parameters["y"] = y
  if (action == "longPress" && durationMs != null) {
    parameters["durationMs"] = durationMs.coerceIn(500, 10_000)
  }
  return mcpClient.callTool("tapAt", parameters)
}

/** Converts a tool parameter value, including nested maps and lists, to JSON. */
internal fun toJsonElement(value: Any?): JsonElement =
  when (value) {
    null -> JsonNull
    is JsonElement -> value
    is String -> JsonPrimitive(value)
    is Number -> JsonPrimitive(value)
    is Boolean -> JsonPrimitive(value)
    is Map<*, *> ->
      JsonObject(value.entries.associate { it.key.toString() to toJsonElement(it.value) })
    is Iterable<*> -> JsonArray(value.map(::toJsonElement))
    else -> JsonPrimitive(value.toString())
  }

/**
 * True when [resultText] is an MCP tool result carrying `isError: true`. A rejected call (for
 * example a strict-schema rejection) arrives as a normal-looking result string, so treating any
 * non-null string as success counted it as a live device (#10089). Non-JSON text is not an error
 * result.
 */
internal fun isToolErrorResult(resultText: String): Boolean {
  if (!resultText.contains("isError")) return false
  val parsed =
    try {
      Json.parseToJsonElement(resultText) as? JsonObject
    } catch (e: kotlinx.serialization.SerializationException) {
      // Not JSON (a plain-text tool result), so it carries no isError flag.
      println("Note: tool result is not JSON, treating it as a non-error: ${e.message}")
      null
    }
  return (parsed?.get("isError") as? JsonPrimitive)?.booleanOrNull == true
}

/** The text content of an MCP tool result, or its JSON when it has none. */
private fun toolResultText(result: JsonElement): String {
  val texts =
    ((result as? JsonObject)?.get("content") as? JsonArray)?.mapNotNull {
      ((it as? JsonObject)?.get("text") as? JsonPrimitive)?.contentOrNull
    }
  return texts?.takeIf { it.isNotEmpty() }?.joinToString("\n") ?: result.toString()
}
