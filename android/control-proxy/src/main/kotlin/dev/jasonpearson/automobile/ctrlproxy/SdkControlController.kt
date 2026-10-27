package dev.jasonpearson.automobile.ctrlproxy

import android.content.BroadcastReceiver
import android.content.Intent
import android.util.Log
import dev.jasonpearson.automobile.protocol.SetNetworkMockRulesResult
import dev.jasonpearson.automobile.sdk.AutoMobileSDK
import dev.jasonpearson.automobile.sdk.network.NetworkMockRuleStore

/**
 * The SDK control broadcasts CtrlProxy sends to the instrumented app: recomposition tracking, the
 * network mock rules (with their correlated reply) and the network error simulation. Everything
 * that needs the service Context or the late-bound WebSocket server comes through [Host].
 */
internal class SdkControlController(
  private val host: Host,
  private val recompositionStore: RecompositionStore,
) {
  /** Service-side operations the controller cannot perform without the service. */
  interface Host {
    fun sendBroadcast(intent: Intent)

    fun sendOrderedBroadcast(intent: Intent, resultReceiver: BroadcastReceiver)

    /** Publishes the correlated mock-rules reply frame to connected clients. */
    fun replyNetworkMockRules(result: SetNetworkMockRulesResult)
  }

  companion object {
    private const val TAG = "CtrlProxy"
  }

  fun setRecompositionTrackingEnabled(enabled: Boolean) {
    recompositionStore.setEnabled(enabled)
    broadcastRecompositionControl(enabled)
    Log.d(TAG, "Recomposition tracking ${if (enabled) "enabled" else "disabled"}")
  }

  private fun broadcastRecompositionControl(enabled: Boolean) {
    try {
      val intent =
        Intent(AutoMobileSDK.ACTION_RECOMPOSITION_CONTROL).apply {
          putExtra(AutoMobileSDK.EXTRA_RECOMPOSITION_ENABLED, enabled)
        }
      host.sendBroadcast(intent)
    } catch (e: SecurityException) {
      Log.e(TAG, "Failed to broadcast recomposition control", e)
    } catch (e: IllegalArgumentException) {
      Log.e(TAG, "Failed to broadcast recomposition control", e)
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.e(TAG, "Failed to broadcast recomposition control", e)
    }
  }

  fun broadcastNetworkMockRules(requestId: String?, rulesJson: String) {
    try {
      val intent =
        Intent(NetworkMockRuleStore.ACTION_NETWORK_MOCK_RULES).apply {
          putExtra(NetworkMockRuleStore.EXTRA_RULES_JSON, rulesJson)
        }
      if (requestId == null) {
        host.sendBroadcast(intent)
        Log.d(TAG, "Broadcast network mock rules")
        return
      }
      // The app's rule store answers an ordered broadcast through its result data (which rules the
      // device's regex engine rejected); forward that to the host as the correlated reply. An SDK
      // that predates the reply leaves the data null and the host reports "not confirmed".
      host.sendOrderedBroadcast(
        intent,
        NetworkMockRulesReplyReceiver(requestId, host::replyNetworkMockRules),
      )
      Log.d(TAG, "Broadcast network mock rules (awaiting report)")
    } catch (e: SecurityException) {
      Log.e(TAG, "Failed to broadcast network mock rules", e)
      if (requestId != null) {
        host.replyNetworkMockRules(
          networkMockRulesFailure(
            requestId,
            "Failed to broadcast network mock rules: ${e.message}",
          ),
        )
      }
    } catch (e: IllegalArgumentException) {
      Log.e(TAG, "Failed to broadcast network mock rules", e)
      if (requestId != null) {
        host.replyNetworkMockRules(
          networkMockRulesFailure(
            requestId,
            "Failed to broadcast network mock rules: ${e.message}",
          ),
        )
      }
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.e(TAG, "Failed to broadcast network mock rules", e)
      if (requestId != null) {
        host.replyNetworkMockRules(
          networkMockRulesFailure(
            requestId,
            "Failed to broadcast network mock rules: ${e.message}",
          ),
        )
      }
    }
  }

  fun broadcastNetworkErrorSimulation(
    enabled: Boolean,
    errorType: String?,
    limit: Int?,
    expiresAtEpochMs: Long?,
    remainingMs: Long?,
  ) {
    try {
      val intent =
        Intent(NetworkMockRuleStore.ACTION_NETWORK_ERROR_SIMULATION).apply {
          remainingMs?.let { putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_REMAINING_MS, it) }
          putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_ENABLED, enabled)
          errorType?.let { putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_TYPE, it) }
          limit?.let { putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_LIMIT, it) }
          expiresAtEpochMs?.let { putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_EXPIRES_AT, it) }
        }
      host.sendBroadcast(intent)
      Log.d(TAG, "Broadcast network error simulation: enabled=$enabled type=$errorType")
    } catch (e: SecurityException) {
      Log.e(TAG, "Failed to broadcast network error simulation", e)
    } catch (e: IllegalArgumentException) {
      Log.e(TAG, "Failed to broadcast network error simulation", e)
    } catch (e: IllegalStateException) {
      if (e is kotlinx.coroutines.CancellationException) throw e
      Log.e(TAG, "Failed to broadcast network error simulation", e)
    }
  }
}
