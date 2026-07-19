package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.mcp.McpConnectionType
import dev.jasonpearson.automobile.desktop.core.mcp.McpProcess

object McpClientFactory {
  /**
   * Creates a client bound to the given [McpProcess], using its connection type and address. Falls
   * back to [createPreferred] when [process] is null.
   */
  fun createFromProcess(process: McpProcess?): AutoMobileClient {
    if (process == null) return createPreferred()
    return when (process.connectionType) {
      McpConnectionType.StreamableHttp -> {
        val port = process.port ?: 3000
        McpHttpClient(normalizeHttpUrl("http://localhost:$port"))
      }
      McpConnectionType.UnixSocket -> {
        val socketPath = process.socketPath ?: DaemonSocketPaths.socketPath()
        McpDaemonClient(socketPath)
      }
      McpConnectionType.Stdio -> {
        throw UnsupportedOperationException("Cannot connect to STDIO process externally")
      }
    }
  }

  fun createPreferred(): AutoMobileClient {
    val configuredHttp = createConfiguredHttp()
    if (configuredHttp != null) {
      return configuredHttp
    }

    val configuredStdio = createConfiguredStdio()
    if (configuredStdio != null) {
      return configuredStdio
    }

    return McpDaemonClient()
  }

  fun createConfiguredHttp(): McpHttpClient? {
    val httpUrl = readSetting("AUTOMOBILE_MCP_HTTP_URL", "automobile.mcp.httpUrl")
    if (!httpUrl.isNullOrBlank()) {
      return McpHttpClient(normalizeHttpUrl(httpUrl))
    }
    return null
  }

  fun createConfiguredStdio(): McpStdioClient? {
    val stdioCommand = readSetting("AUTOMOBILE_MCP_STDIO_COMMAND", "automobile.mcp.stdioCommand")
    if (!stdioCommand.isNullOrBlank()) {
      return McpStdioClient(stdioCommand)
    }
    return null
  }

  private fun readSetting(envKey: String, propertyKey: String): String? {
    val envValue = System.getenv(envKey)
    if (!envValue.isNullOrBlank()) {
      return envValue
    }
    val propertyValue = System.getProperty(propertyKey)
    return propertyValue?.takeIf { it.isNotBlank() }
  }

  fun normalizeHttpUrl(raw: String): String {
    val trimmed = raw.trim().removeSuffix("/")
    return when {
      trimmed.endsWith("/auto-mobile/streamable") || trimmed.endsWith("/auto-mobile/sse") -> trimmed
      trimmed.endsWith("/auto-mobile") -> "$trimmed/streamable"
      trimmed.contains("/auto-mobile/") -> trimmed
      else -> "$trimmed/auto-mobile/streamable"
    }
  }
}
