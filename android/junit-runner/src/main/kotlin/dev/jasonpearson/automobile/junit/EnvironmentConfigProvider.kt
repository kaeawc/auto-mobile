package dev.jasonpearson.automobile.junit

import dev.jasonpearson.automobile.junit.AutoMobileAgent.ConfigProvider
import dev.jasonpearson.automobile.junit.AutoMobileAgent.ModelConfig
import dev.jasonpearson.automobile.junit.AutoMobileAgent.ModelProvider

internal class EnvironmentConfigProvider : ConfigProvider {
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
              "OpenAI API key not found. Set OPENAI_API_KEY environment variable or automobile.openai.api.key system property",
            )

        ModelProvider.ANTHROPIC ->
          System.getenv("ANTHROPIC_API_KEY")
            ?: System.getProperty("automobile.anthropic.api.key")
            ?: throw RuntimeException(
              "Anthropic API key not found. Set ANTHROPIC_API_KEY environment variable or automobile.anthropic.api.key system property",
            )

        ModelProvider.GOOGLE ->
          System.getenv("GOOGLE_API_KEY")
            ?: System.getProperty("automobile.google.api.key")
            ?: throw RuntimeException(
              "Google API key not found. Set GOOGLE_API_KEY environment variable or automobile.google.api.key system property",
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
