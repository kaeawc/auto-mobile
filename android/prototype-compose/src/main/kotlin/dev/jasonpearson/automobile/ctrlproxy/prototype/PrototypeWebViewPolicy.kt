package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeWebView
import java.net.URI
import java.net.URISyntaxException

internal object PrototypeWebViewPolicy {
  sealed interface Decision

  data object Allow : Decision

  data class Block(val reason: String) : Decision

  // The frame is intentionally not a policy input: top frames and resources share every check.
  @Suppress("UnusedParameter", "ReturnCount")
  fun check(
    url: String,
    allowedOrigins: List<String>,
    isMainFrame: Boolean,
    daemonPorts: Set<Int> = emptySet(),
  ): Decision {
    val uri =
      try {
        URI(url)
      } catch (_: URISyntaxException) {
        return Block("Malformed URL")
      }
    if (uri.scheme != "https") return Block("HTTPS is required")
    if (uri.rawUserInfo != null) return Block("URL credentials are forbidden")
    val host = uri.host?.lowercase() ?: return Block("A DNS host is required")
    if (':' in host || PrototypeWebView.privateHost(host.trimEnd('.')))
      return Block("Private or numeric host")
    val port = uri.port
    if (isDaemonPort(port, daemonPorts)) return Block("Daemon port")
    if (port != -1 && port !in 1..65535) return Block("Invalid port")
    // Reject ambiguous authorities such as a trailing colon or a zero-padded port.
    val authority = host + if (port == -1) "" else ":$port"
    if (!authority.equals(uri.rawAuthority, ignoreCase = true)) return Block("Malformed authority")
    return if (origin(host, port) in allowedOrigins) Allow
    else Block("Origin is outside allowedOrigins")
  }

  private fun isDaemonPort(port: Int, additionalPorts: Set<Int>): Boolean =
    port in additionalPorts || port in 3000..3010 || port == 8765

  private fun origin(host: String, port: Int): String =
    if (port == -1 || port == 443) "https://$host" else "https://$host:$port"
}
