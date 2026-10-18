package dev.jasonpearson.automobile.desktop.core.daemon

import java.util.UUID

/**
 * Holds the single MCP session key for one desktop app session. Clients are built per action, so
 * the key must live here rather than on the client or device binding is lost between actions.
 */
class McpSessionKeyProvider(val key: String = UUID.randomUUID().toString()) {
  companion object {
    /** The app-session-scoped provider shared by every client built in this process. */
    val appSession: McpSessionKeyProvider by lazy { McpSessionKeyProvider() }
  }
}
