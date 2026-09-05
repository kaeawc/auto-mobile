package dev.jasonpearson.automobile.junit

import ai.koog.agents.core.agent.AIAgent
import ai.koog.agents.core.tools.SimpleTool
import ai.koog.agents.core.tools.ToolRegistry
import ai.koog.prompt.executor.clients.anthropic.AnthropicModels
import ai.koog.prompt.executor.clients.openai.OpenAIModels
import ai.koog.prompt.executor.model.PromptExecutor
import ai.koog.prompt.llm.LLModel
import ai.koog.serialization.typeToken
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

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
      throw RuntimeException("Failed to generate YAML plan from prompt: ${e.message}", e)
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
   * [AutoMobilePlanExecutor]) — if the obstruction is gone that step now passes.
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
      // Known limitation (follow-up): the wrapper also redacts the intermediate observe result that
      // the composite WaitForTool searches locally — its own output to the model is synthesized and
      // safe, so there is no leak, but a wait target that is a substring of an on-screen secret can
      // falsely time out. A clean fix hands composite tools the raw client; deferred to keep this
      // security change scoped.
      //
      // Normalize the incoming concrete secret values into every scrub form (NFC/NFD + the
      // transport-encoding depths) HERE, at the public recovery entry point, so the loop is safe
      // whether a caller passed raw or pre-expanded values: this is a public overload, so a direct
      // caller could pass raw concrete secrets, and matching only those would miss the escaped
      // representation in JSON tool results. Idempotent for the executor's already-expanded input.
      val redactionValues = SecretRedactor.secretValues(secretValues)
      val agentMcpClient =
        if (redactionValues.isEmpty()) mcpClient else RedactingMCPClient(mcpClient, redactionValues)
      val aiAgent =
        aiAgentFactory.createAIAgentWithMCPTools(modelConfig, agentMcpClient, maxToolCalls)

      // Redact the STATIC context fields that go into the initial prompt too (#6094). The executor
      // already redacts these on the FailedStepContext (#6092), so this is a no-op for that path;
      // it
      // makes the public entry point self-contained, so a direct caller who supplies raw context
      // fields alongside raw secretValues cannot leak them in the first ModelRequest. Redacting an
      // already-redacted field changes nothing.
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

      val recoveryPrompt =
        """
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

      val recoveryResult = runBlocking {
        try {
          println(
            "Starting AI recovery for step ${context.failedStepIndex + 1} (${context.failedTool})..."
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
              SecretRedactor.redact(
                mcpClient.callTool("observe", mapOf("withViewHierarchy" to true)),
                redactionValues,
              )
            } catch (e: Exception) {
              println("Warning: Post-recovery observe failed: ${e.message}")
              null
            }

          val recoveryTime = timeProvider.currentTimeMillis() - startTime
          RecoveryOutcome(
            success = observeResult != null,
            recoveryTimeMs = recoveryTime,
            observeResultAfterRecovery = observeResult,
          )
        } catch (e: Exception) {
          println("AI recovery execution failed: ${e.message}")
          val recoveryTime = timeProvider.currentTimeMillis() - startTime
          RecoveryOutcome(false, recoveryTime)
        }
      }

      return recoveryResult
    } catch (e: Exception) {
      println("AI recovery initialization failed: ${e.message}")
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

      val planGenerationPrompt =
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

      return runBlocking {
        try {
          val response = aiAgent.run(planGenerationPrompt)

          // Extract YAML content from the response
          val yamlContent = extractYamlFromResponse(response)

          if (yamlContent.isEmpty()) {
            throw RuntimeException("AI agent generated empty YAML content")
          }

          val debugMode = configProvider.isDebugMode()
          if (debugMode) {
            println("AI agent generated plan:\n$yamlContent")
          }

          yamlContent
        } catch (e: Exception) {
          throw RuntimeException("Plan generation via AI agent failed: ${e.message}", e)
        }
      }
    } catch (e: Exception) {
      throw RuntimeException("Failed to initialize AI agent for plan generation: ${e.message}", e)
    }
  }

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

  class DefaultMCPClient : MCPClient {
    private val httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build()
    private var serverUrl: String? = null
    private val koogJson = Json { ignoreUnknownKeys = true }

    override fun isConnected(): Boolean {
      return serverUrl != null && testConnection()
    }

    override fun connect(serverUrl: String) {
      this.serverUrl = serverUrl
      if (!testConnection()) {
        throw RuntimeException("Failed to connect to AutoMobile MCP server at $serverUrl")
      }
      println("Connected to AutoMobile MCP server at $serverUrl")
    }

    override fun disconnect() {
      serverUrl = null
    }

    override fun callTool(toolName: String, parameters: Map<String, Any>): String {
      val url = serverUrl ?: throw RuntimeException("MCP client not connected")

      try {
        val requestJson =
          koogJson.encodeToString(
            buildJsonObject {
              put("method", JsonPrimitive("tools/call"))
              put(
                "params",
                buildJsonObject {
                  put("name", JsonPrimitive(toolName))
                  put("arguments", buildJsonParameters(parameters))
                },
              )
            }
          )

        val request =
          HttpRequest.newBuilder()
            .uri(URI.create("$url/mcp"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(requestJson))
            .timeout(Duration.ofSeconds(30))
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())

        if (response.statusCode() != 200) {
          throw RuntimeException(
            "MCP server returned status ${response.statusCode()}: ${response.body()}"
          )
        }

        val mcpResponse = koogJson.decodeFromString<MCPResponse>(response.body())

        if (mcpResponse.error != null) {
          throw RuntimeException("MCP server error: ${mcpResponse.error}")
        }

        return mcpResponse.result?.toString() ?: ""
      } catch (e: Exception) {
        throw RuntimeException("Failed to call MCP tool $toolName: ${e.message}", e)
      }
    }

    override fun listAvailableTools(): List<MCPToolDefinition> {
      val url = serverUrl ?: throw RuntimeException("MCP client not connected")

      try {
        val requestJson =
          koogJson.encodeToString(
            buildJsonObject {
              put("method", JsonPrimitive("tools/list"))
              put("params", JsonObject(emptyMap()))
            }
          )

        val request =
          HttpRequest.newBuilder()
            .uri(URI.create("$url/mcp"))
            .header("Content-Type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(requestJson))
            .timeout(Duration.ofSeconds(10))
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())

        if (response.statusCode() != 200) {
          throw RuntimeException(
            "MCP server returned status ${response.statusCode()}: ${response.body()}"
          )
        }

        val mcpResponse = koogJson.decodeFromString<MCPResponse>(response.body())
        return parseListToolsResponse(mcpResponse)
      } catch (e: Exception) {
        throw RuntimeException("Failed to list MCP tools: ${e.message}", e)
      }
    }

    /**
     * Parse a tools/list MCP response. A well-formed response with no `error` but a null/absent
     * `result` previously hit `result!!` and produced a misleading `... null` NPE; report an
     * actionable message instead (#3607).
     */
    internal fun parseListToolsResponse(mcpResponse: MCPResponse): List<MCPToolDefinition> {
      if (mcpResponse.error != null) {
        throw RuntimeException("MCP server error: ${mcpResponse.error}")
      }
      val result = mcpResponse.result ?: throw RuntimeException("MCP tools/list returned no result")
      return koogJson.decodeFromString<MCPListToolsResponse>(result.toString()).tools
    }

    private fun buildJsonParameters(parameters: Map<String, Any>): JsonObject = buildJsonObject {
      parameters.forEach { (key, value) ->
        put(
          key,
          when (value) {
            is String -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            else -> JsonPrimitive(value.toString())
          },
        )
      }
    }

    private fun testConnection(): Boolean {
      val url = serverUrl ?: return false

      try {
        val request =
          HttpRequest.newBuilder()
            .uri(URI.create("$url/health"))
            .timeout(Duration.ofSeconds(5))
            .build()

        val response = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
        return response.statusCode() == 200
      } catch (e: Exception) {
        return false
      }
    }
  }

  // Class-based AutoMobile MCP Tools (no reflection required)
  // These tools use Koog's SimpleTool pattern for Robolectric compatibility

  /** Observe the current device state and UI hierarchy */
  class ObserveTool(private val mcpClient: MCPClient) :
    SimpleTool<ObserveTool.Args>(
      argsType = typeToken<Args>(),
      name = "observe",
      description = "Observe the current device state and UI hierarchy",
    ) {

    @Serializable
    data class Args(val withViewHierarchy: Boolean = true, val includeInvisible: Boolean = false)

    override suspend fun execute(args: Args): String {
      val parameters =
        mapOf(
          "withViewHierarchy" to args.withViewHierarchy,
          "includeInvisible" to args.includeInvisible,
        )
      return mcpClient.callTool("observe", parameters)
    }
  }

  /** Tap on UI elements by text, coordinates, or description */
  class TapOnTool(private val mcpClient: MCPClient) :
    SimpleTool<TapOnTool.Args>(
      argsType = typeToken<Args>(),
      name = "tapOn",
      description = "Tap on UI elements by text, coordinates, or description",
    ) {

    @Serializable
    data class Args(
      val text: String? = null,
      val id: String? = null,
      val x: Int? = null,
      val y: Int? = null,
    )

    override suspend fun execute(args: Args): String {
      val parameters = mutableMapOf<String, Any>()
      args.text?.let { parameters["text"] = it }
      args.id?.let { parameters["id"] = it }
      args.x?.let { parameters["x"] = it }
      args.y?.let { parameters["y"] = it }

      if (parameters.isEmpty()) {
        throw IllegalArgumentException("Must specify either text, id, or coordinates (x, y)")
      }

      return mcpClient.callTool("tapOn", parameters)
    }
  }

  /** Enter text into input fields or send text to the device */
  class TypeTextTool(private val mcpClient: MCPClient) :
    SimpleTool<TypeTextTool.Args>(
      argsType = typeToken<Args>(),
      name = "typeText",
      description = "Enter text into input fields or send text to the device",
    ) {

    @Serializable data class Args(val text: String)

    override suspend fun execute(args: Args): String {
      val parameters = mapOf("text" to args.text)
      return mcpClient.callTool("sendText", parameters)
    }
  }

  /** Input text with optional IME action */
  class InputTextTool(private val mcpClient: MCPClient) :
    SimpleTool<InputTextTool.Args>(
      argsType = typeToken<Args>(),
      name = "inputText",
      description = "Input text with optional IME action",
    ) {

    @Serializable data class Args(val text: String, val imeAction: String? = null)

    override suspend fun execute(args: Args): String {
      val parameters = mutableMapOf<String, Any>("text" to args.text)
      args.imeAction?.let { parameters["imeAction"] = it }
      return mcpClient.callTool("inputText", parameters)
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

      return if (args.containerElementId != null) {
        parameters["containerElementId"] = args.containerElementId
        mcpClient.callTool("scroll", parameters)
      } else {
        parameters["includeSystemInsets"] = false
        parameters["duration"] = 300
        mcpClient.callTool("swipeOnScreen", parameters)
      }
    }
  }

  /** Scroll within a container element */
  class ScrollTool(private val mcpClient: MCPClient) :
    SimpleTool<ScrollTool.Args>(
      argsType = typeToken<Args>(),
      name = "scroll",
      description = "Scroll within a container element",
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
          "containerElementId" to args.containerElementId,
          "direction" to args.direction,
        )

      if (args.lookForText != null || args.lookForElementId != null) {
        val lookFor = mutableMapOf<String, Any>()
        args.lookForText?.let { lookFor["text"] = it }
        args.lookForElementId?.let { lookFor["elementId"] = it }
        parameters["lookFor"] = lookFor
      }

      return mcpClient.callTool("scroll", parameters)
    }
  }

  /** Wait for elements to appear or conditions to be met */
  class WaitForTool(private val mcpClient: MCPClient) :
    SimpleTool<WaitForTool.Args>(
      argsType = typeToken<Args>(),
      name = "waitFor",
      description = "Wait for elements to appear or conditions to be met",
    ) {

    @Serializable
    data class Args(
      val text: String? = null,
      val elementId: String? = null,
      val timeout: Int = 5000,
    )

    override suspend fun execute(args: Args): String {
      // Note: The current MCP server doesn't have a dedicated waitFor tool
      // We'll simulate it by repeatedly calling observe until the element is found
      val startTime = System.currentTimeMillis()
      val endTime = startTime + args.timeout

      while (System.currentTimeMillis() < endTime) {
        try {
          val observeResult = mcpClient.callTool("observe", mapOf("withViewHierarchy" to true))

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
        Thread.sleep(500)
      }

      val target = args.text ?: args.elementId ?: "unknown"
      throw RuntimeException("Timeout waiting for element: $target")
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

  /** Clear text from input fields */
  class ClearTextTool(private val mcpClient: MCPClient) :
    SimpleTool<ClearTextTool.Args>(
      argsType = typeToken<Args>(),
      name = "clearText",
      description = "Clear text from input fields",
    ) {

    @Serializable class Args

    override suspend fun execute(args: Args): String {
      return mcpClient.callTool("clearText", emptyMap())
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

    override suspend fun execute(args: Args): String {
      val parameters = mapOf("x" to args.x, "y" to args.y)
      return mcpClient.callTool("doubleTapOn", parameters)
    }
  }

  /** Long press on coordinates or elements */
  class LongPressOnTool(private val mcpClient: MCPClient) :
    SimpleTool<LongPressOnTool.Args>(
      argsType = typeToken<Args>(),
      name = "longPressOn",
      description = "Long press on coordinates or elements",
    ) {

    @Serializable
    data class Args(
      val text: String? = null,
      val id: String? = null,
      val x: Int? = null,
      val y: Int? = null,
      val duration: Int = 1000,
    )

    override suspend fun execute(args: Args): String {
      val parameters = mutableMapOf<String, Any>("duration" to args.duration)
      args.text?.let { parameters["text"] = it }
      args.id?.let { parameters["id"] = it }
      args.x?.let { parameters["x"] = it }
      args.y?.let { parameters["y"] = it }

      if (parameters.size == 1) { // Only duration was set
        throw IllegalArgumentException("Must specify either text, id, or coordinates (x, y)")
      }

      return mcpClient.callTool("longPressOn", parameters)
    }
  }

  /** Helper to create all MCP tools for an agent */
  class AutoMobileMCPToolFactory(private val mcpClient: MCPClient) {
    fun createAllTools(): List<SimpleTool<*>> =
      listOf(
        ObserveTool(mcpClient),
        TapOnTool(mcpClient),
        TypeTextTool(mcpClient),
        InputTextTool(mcpClient),
        SwipeTool(mcpClient),
        ScrollTool(mcpClient),
        WaitForTool(mcpClient),
        GoBackTool(mcpClient),
        PressButtonTool(mcpClient),
        ClearTextTool(mcpClient),
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

    fun createAIAgentWithMCPTools(
      config: ModelConfig,
      mcpClient: MCPClient,
      maxToolCalls: Int = 5,
    ): AIAgent<String, String>
  }

  interface TimeProvider {
    fun currentTimeMillis(): Long
  }

  // Default implementations
  class DefaultConfigProvider : ConfigProvider {
    override fun getModelConfig(): ModelConfig {
      // Check for model provider preference (default to OpenAI)
      val provider =
        when (System.getProperty("automobile.ai.provider", "openai")?.lowercase()) {
          "anthropic" -> ModelProvider.ANTHROPIC
          "google" -> ModelProvider.GOOGLE
          else -> ModelProvider.OPENAI
        }

      // Get API key for the selected provider
      val apiKey =
        when (provider) {
          ModelProvider.OPENAI ->
            System.getenv("OPENAI_API_KEY")
              ?: System.getProperty("automobile.openai.api.key")
              ?: throw RuntimeException(
                "OpenAI API key not found. Set OPENAI_API_KEY environment variable or automobile.openai.api.key system property"
              )

          ModelProvider.ANTHROPIC ->
            System.getenv("ANTHROPIC_API_KEY")
              ?: System.getProperty("automobile.anthropic.api.key")
              ?: throw RuntimeException(
                "Anthropic API key not found. Set ANTHROPIC_API_KEY environment variable or automobile.anthropic.api.key system property"
              )

          ModelProvider.GOOGLE ->
            System.getenv("GOOGLE_API_KEY")
              ?: System.getProperty("automobile.google.api.key")
              ?: throw RuntimeException(
                "Google API key not found. Set GOOGLE_API_KEY environment variable or automobile.google.api.key system property"
              )
        }

      // Optional proxy endpoint
      val proxyEndpoint = System.getProperty("automobile.ai.proxy.endpoint")

      return ModelConfig(provider, apiKey, proxyEndpoint)
    }

    override fun getPlanMaxAgeMs(): Long {
      return System.getProperty("automobile.plan.max.age.ms", "3600000").toLong() // 1 hour default
    }

    override fun isDebugMode(): Boolean {
      return System.getProperty("automobile.debug", "false").toBoolean()
    }

    override fun getMcpServerUrl(): String {
      // The URL was mistakenly passed as the property NAME (1-arg getProperty),
      // which is never set, so this returned null and AI recovery could never
      // connect to the MCP server (#3596). Use the 2-arg form with the URL default.
      return System.getProperty("automobile.mcp.server.url", "http://localhost:3000")
    }
  }

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

  class DefaultAIAgentFactory : AIAgentFactory {
    override fun createAIAgent(config: ModelConfig): AIAgent<String, String> {
      val executor = createPromptExecutor(config)
      val model = selectModel(config.provider)

      val systemPrompt =
        """
        You are an expert in mobile test automation using the AutoMobile framework.
        You help generate YAML test plans and provide recovery suggestions for failed tests.

        Your responses should be:
        - Specific and actionable
        - Focused on mobile automation best practices
        - Clear and concise
        - Include proper YAML formatting when generating plans

        When generating YAML plans, always include proper structure with name, description, and steps.
        When providing recovery suggestions, focus on common mobile testing issues and practical solutions.
        """
          .trimIndent()

      return AIAgent(
        promptExecutor = executor,
        llmModel = model,
        toolRegistry = ToolRegistry.EMPTY,
        systemPrompt = systemPrompt,
      )
    }

    override fun createAIAgentWithMCPTools(
      config: ModelConfig,
      mcpClient: MCPClient,
      maxToolCalls: Int,
    ): AIAgent<String, String> {
      val executor = createPromptExecutor(config)
      val model = selectModel(config.provider)

      // Create AutoMobile MCP tools using class-based pattern (no reflection)
      val toolFactory = AutoMobileMCPToolFactory(mcpClient)
      val toolRegistry = ToolRegistry { toolFactory.createAllTools().forEach { tool(it) } }

      val systemPrompt =
        """
        You are an expert mobile test automation recovery agent using the AutoMobile framework.

        Your goal is to clear whatever interruption blocked a failing test step — typically a
        modal, popup, system notification, permission dialog, or crash/ANR dialog — and return
        the app to the screen that step expects. You have access to AutoMobile tools for
        observing and interacting with mobile devices, discovered dynamically from the MCP server.

        The test runner re-runs the failed step itself after you finish, so do NOT perform that
        step's action — just remove the obstruction.

        IMPORTANT CONSTRAINTS:
        - You have a maximum of $maxToolCalls tool calls per recovery attempt
        - Always start by observing the current device state
        - Focus on dismissing blockers, not on completing the test's own actions
        - If you can't fix the issue within the tool call limit, explain what you discovered

        Core tools typically available:
        - observe: Get current UI state and hierarchy
        - tapOn: Tap elements by text, id, or coordinates
        - typeText/inputText: Enter text in input fields
        - swipe/scroll: Navigate with gestures or within containers
        - waitFor: Wait for elements or conditions (implemented as polling)
        - goBack/pressButton: Navigate back or press hardware buttons
        - launchApp/terminateApp: Manage app lifecycle
        - clearText: Clear input fields

        Additional tools may be available depending on the MCP server configuration.

        Always be methodical: observe first, understand the problem, then take targeted actions.
        Use the most appropriate tool for each interaction based on what's available.
      """
          .trimIndent()

      // Hard-enforce the tool-call budget: cap Koog's agent loop via maxIterations so a
      // looping or runaway model cannot exceed the budget the prompt advertises. Without
      // this the "$maxToolCalls tool calls" line is advisory only. See [recoveryIterationCap]
      // for why the ceiling is maxToolCalls + 1. When the cap is hit Koog throws, which the
      // caller's try/catch turns into a failed RecoveryOutcome (we do not resume).
      return AIAgent(
        promptExecutor = executor,
        llmModel = model,
        toolRegistry = toolRegistry,
        systemPrompt = systemPrompt,
        maxIterations = recoveryIterationCap(maxToolCalls),
      )
    }

    private fun createPromptExecutor(config: ModelConfig): PromptExecutor =
      when (config.provider) {
        ModelProvider.OPENAI -> PromptExecutor.builder().openAI(config.apiKey).build()
        ModelProvider.ANTHROPIC -> PromptExecutor.builder().anthropic(config.apiKey).build()
        ModelProvider.GOOGLE -> unsupportedGoogleProvider()
      }

    private fun selectModel(provider: ModelProvider): LLModel =
      when (provider) {
        ModelProvider.OPENAI -> OpenAIModels.Chat.GPT4o
        ModelProvider.ANTHROPIC -> AnthropicModels.Sonnet_4
        ModelProvider.GOOGLE -> unsupportedGoogleProvider()
      }

    private fun unsupportedGoogleProvider(): Nothing {
      throw UnsupportedOperationException(
        "Koog 1.0.0 stable artifacts do not publish a Google prompt executor; use OpenAI or Anthropic."
      )
    }
  }

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
