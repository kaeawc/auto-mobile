package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.serialization.json.Json

data class McpHttpClientOptions(
  val endpoint: String,
  val json: Json = DaemonJson,
  val retryPolicy: RetryPolicy = RetryPolicy(),
  val statusRequestTimeoutMs: Long = McpDaemonClient.STATUS_REQUEST_TIMEOUT_MS,
  val statusDeadlineFactory: (Long) -> StatusRequestDeadline = {
    StatusRequestDeadline(it)
  },
  val requestSender: HttpRequestSender? = null,
  val mcpSessionKey: String = McpSessionKeyProvider.appSession.key,
  val tokenProvider: DaemonHttpTokenProvider = FileDaemonHttpTokenProvider(),
  val requestHeaders: Map<String, String> = emptyMap(),
)
