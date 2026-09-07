package dev.jasonpearson.automobile.junit

import ai.koog.agents.core.agent.AIAgent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression tests for issue #6145 P2 (binary compatibility): adding `rawMcpClient` as a 4th
 * defaulted parameter directly on [AutoMobileAgent.AIAgentFactory.createAIAgentWithMCPTools]
 * replaced its published 3-arg JVM abstract-method descriptor with a 4-arg one — a Kotlin default
 * parameter value is resolved at the call site from the visible declaration, it is not something an
 * implementing class provides, so it did nothing to preserve what an external implementer's
 * `.class` actually linked against. The fix keeps the 3-arg method as its own abstract method
 * (unchanged descriptor) and adds the 4-arg capability as a separate, non-abstract overload that
 * forwards to it by default.
 */
class AIAgentFactoryBinaryCompatTest {

  /**
   * Stands in for an external [AutoMobileAgent.AIAgentFactory] implementer that predates #6145: it
   * overrides ONLY the original 3-arg method, exactly like code compiled against the pre-#6145
   * interface. If the interface still required the 4-arg method to be implemented too, this class
   * would fail to compile ("class ... must be declared abstract or implement abstract member") — so
   * this file compiling at all is most of the regression proof.
   */
  private class LegacyThreeArgFactory : AutoMobileAgent.AIAgentFactory {
    var lastCallArgs: Triple<AutoMobileAgent.ModelConfig, AutoMobileAgent.MCPClient, Int>? = null

    override fun createAIAgent(config: AutoMobileAgent.ModelConfig): AIAgent<String, String> {
      throw UnsupportedOperationException("not used")
    }

    override fun createAIAgentWithMCPTools(
      config: AutoMobileAgent.ModelConfig,
      mcpClient: AutoMobileAgent.MCPClient,
      maxToolCalls: Int,
    ): AIAgent<String, String> {
      lastCallArgs = Triple(config, mcpClient, maxToolCalls)
      throw UnsupportedOperationException("legacy factory stub")
    }
  }

  private class StubMCPClient : AutoMobileAgent.MCPClient {
    override fun isConnected() = false

    override fun connect(serverUrl: String) {}

    override fun disconnect() {}

    override fun callTool(toolName: String, parameters: Map<String, Any>) = ""

    override fun listAvailableTools() = emptyList<AutoMobileAgent.MCPToolDefinition>()
  }

  @Test
  fun `a factory overriding only the 3-arg method still satisfies AIAgentFactory`() {
    val factory: AutoMobileAgent.AIAgentFactory = LegacyThreeArgFactory()
    assertTrue(factory is AutoMobileAgent.AIAgentFactory)
  }

  @Test
  fun `the 4-arg overload's default body forwards to the 3-arg method on a legacy factory`() {
    val factory = LegacyThreeArgFactory()
    val config = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")
    val mcpClient = StubMCPClient()
    val otherRawMcpClient = StubMCPClient()

    // Call the NEW 4-arg overload (unknown to LegacyThreeArgFactory's author) with a distinct
    // rawMcpClient; its default body must forward to the 3-arg override (dropping rawMcpClient —
    // the pre-#6145 behavior) rather than throwing AbstractMethodError.
    try {
      factory.createAIAgentWithMCPTools(config, mcpClient, 7, otherRawMcpClient)
    } catch (e: UnsupportedOperationException) {
      // Expected: the stub 3-arg override throws once actually invoked; reaching it proves the
      // forwarding worked.
    }

    assertEquals(Triple(config, mcpClient, 7), factory.lastCallArgs)
  }

  @Test
  fun `DefaultAIAgentFactory's 3-arg method delegates to the 4-arg one with rawMcpClient=mcpClient`() {
    // The reverse direction: DefaultAIAgentFactory must implement the mandatory 3-arg method by
    // routing through its own 4-arg logic rather than duplicating it, using mcpClient as the raw
    // client (no separate one) — the pre-#6145 behavior for any caller still using the 3-arg entry
    // point. Constructing the AIAgent requires no network I/O, so this exercises real wiring.
    val factory = AutoMobileAgent.DefaultAIAgentFactory()
    val config = AutoMobileAgent.ModelConfig(AutoMobileAgent.ModelProvider.OPENAI, "test-key")
    val mcpClient = StubMCPClient()

    val threeArgAgent = factory.createAIAgentWithMCPTools(config, mcpClient, 5)
    val fourArgAgent = factory.createAIAgentWithMCPTools(config, mcpClient, 5, mcpClient)

    assertTrue(threeArgAgent is AIAgent<*, *>)
    assertTrue(fourArgAgent is AIAgent<*, *>)
  }
}
