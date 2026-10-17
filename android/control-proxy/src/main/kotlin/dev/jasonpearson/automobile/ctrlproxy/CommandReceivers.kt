package dev.jasonpearson.automobile.ctrlproxy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

private const val TAG = "CtrlProxy"

/** The service members the command receiver needs: command dispatch and the failure result. */
internal interface CommandHost {
  suspend fun handleCommand(intent: Intent)

  fun sendFailure(error: String?)
}

/** Receives ADB-broadcast commands and dispatches each one on [scope]. */
internal class CommandReceiver(
  private val scope: CoroutineScope,
  private val host: CommandHost,
) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent == null) {
      Log.w(TAG, "no intent")
      return
    }

    Log.d(TAG, "Received broadcast: ${intent.action}")

    scope.launch {
      try {
        host.handleCommand(intent)
      } catch (e: CancellationException) {
        // Cooperative cancellation (service scope shutting down) must never become an error
        // result — let it propagate so the coroutine unwinds cleanly. Mirrors the inner
        // ACTION_EXTRACT_HIERARCHY rethrow (PR #3126), which would otherwise be re-swallowed
        // here (issue #3130).
        throw e
      } catch (e: Exception) {
        Log.e(TAG, "Error handling command: ${intent.action}", e)
        host.sendFailure(e.message)
      }
    }
  }
}

/**
 * Receives the app's answer to an ordered network-mock-rules broadcast and replies to the host with
 * the correlated result; the answer's result data lists the rules the device rejected.
 */
internal class NetworkMockRulesReplyReceiver(
  private val requestId: String,
  private val reply: (SetNetworkMockRulesResult) -> Unit,
) : BroadcastReceiver() {
  override fun onReceive(context: Context?, intent: Intent?) {
    reply(networkMockRulesResult(requestId, resultData))
  }
}
