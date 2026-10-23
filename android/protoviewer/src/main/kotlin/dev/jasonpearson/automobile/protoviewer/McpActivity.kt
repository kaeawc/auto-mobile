package dev.jasonpearson.automobile.protoviewer

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import java.util.logging.Level
import java.util.logging.Logger
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The MCP host's entry point (#13621). The manifest exports it only to callers holding
 * android.permission.DUMP (the adb shell), with no intent filters, so only an explicit `am start
 * -n` from adb reaches it. It is translucent and finishes as soon as the command is done.
 */
class McpActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val services = (application as ProtoViewerApplication).services
    val command =
      McpCommand.parse(
        intent.action,
        intent.getStringExtra(MCP_EXTRA_REQUEST),
        intent.getStringExtra(MCP_EXTRA_LABEL),
        intent.getStringExtra(MCP_EXTRA_LIBRARY_ID),
      )
    val inbox = services.mcpInbox
    // A recreated activity must not replay a command; the host's wait simply times out.
    if (savedInstanceState != null || command == null || inbox == null) {
      logger.warning("Ignoring MCP launch (command=${command != null}, inbox=${inbox != null})")
      finish()
      return
    }
    lifecycleScope.launch {
      val open =
        try {
          withContext(services.io) { inbox.handle(command) }
        } catch (error: java.io.IOException) {
          // No result could be written; the host reports its own timeout.
          logger.log(Level.WARNING, "MCP command failed", error)
          null
        }
      open?.let { ViewerLaunch.open(this@McpActivity, it) }
      finish()
    }
  }

  private companion object {
    val logger: Logger = Logger.getLogger("ProtoViewerMcp")
  }
}
