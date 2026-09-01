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

  /**
   * Creates the app's preferred client. When [bootstrap] is provided and the Unix-socket daemon is
   * selected, the client shares the bootstrap's lifecycle so its per-request preflights report
   * their progress to the launch surfaces; non-daemon transports mark the bootstrap inactive.
   */
  fun createPreferred(bootstrap: DaemonBootstrap? = null): AutoMobileClient {
    val configuredHttp = createConfiguredHttp()
    if (configuredHttp != null) {
      bootstrap?.markInactive()
      return configuredHttp
    }

    val configuredStdio = createConfiguredStdio()
    if (configuredStdio != null) {
      bootstrap?.markInactive()
      return configuredStdio
    }

    return if (bootstrap != null) {
      McpDaemonClient(DaemonSocketPaths.socketPath(), bootstrap.lifecycle)
    } else {
      McpDaemonClient()
    }
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
