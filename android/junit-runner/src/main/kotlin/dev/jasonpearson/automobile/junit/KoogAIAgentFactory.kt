package dev.jasonpearson.automobile.junit

import ai.koog.agents.core.agent.AIAgent
import ai.koog.agents.core.tools.ToolRegistry
import ai.koog.prompt.executor.clients.anthropic.AnthropicModels
import ai.koog.prompt.executor.clients.openai.OpenAIModels
import ai.koog.prompt.executor.model.PromptExecutor
import ai.koog.prompt.llm.LLModel
import dev.jasonpearson.automobile.junit.AutoMobileAgent.AIAgentFactory
import dev.jasonpearson.automobile.junit.AutoMobileAgent.AutoMobileMCPToolFactory
import dev.jasonpearson.automobile.junit.AutoMobileAgent.MCPClient
import dev.jasonpearson.automobile.junit.AutoMobileAgent.ModelConfig
import dev.jasonpearson.automobile.junit.AutoMobileAgent.ModelProvider

internal class KoogAIAgentFactory : AIAgentFactory {
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

  // The original (pre-#6145) abstract method's mandatory override; see the interface doc on the
  // 3-arg createAIAgentWithMCPTools for why this is a distinct method rather than a defaulted
  // rawMcpClient parameter. Delegates to the 4-arg overload with rawMcpClient=mcpClient — no
  // separate raw client, matching the pre-#6145 behavior this method's callers expect.
  override fun createAIAgentWithMCPTools(
    config: ModelConfig,
    mcpClient: MCPClient,
    maxToolCalls: Int,
  ): AIAgent<String, String> = createAIAgentWithMCPTools(config, mcpClient, maxToolCalls, mcpClient)

  override fun createAIAgentWithMCPTools(
    config: ModelConfig,
    mcpClient: MCPClient,
    maxToolCalls: Int,
    rawMcpClient: MCPClient,
  ): AIAgent<String, String> {
    val executor = createPromptExecutor(config)
    val model = selectModel(config.provider)

    // Create AutoMobile MCP tools using class-based pattern (no reflection). WaitForTool gets the
    // raw client (#6145); every other, pass-through tool gets mcpClient (the redacting wrapper
    // during recovery).
    val toolFactory = AutoMobileMCPToolFactory(mcpClient, rawMcpClient)
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
      - tapOn: Tap elements by text or id, or at coordinates
      - typeText/sendKeys: Enter, clear, or submit text in input fields
      - swipe/scroll: Navigate with gestures or within containers
      - waitFor: Wait for elements or conditions (implemented as polling)
      - goBack/pressButton: Navigate back or press hardware buttons
      - launchApp/terminateApp: Manage app lifecycle

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
      "Koog 1.0.0 stable artifacts do not publish a Google prompt executor; use OpenAI or Anthropic.",
    )
  }
}
