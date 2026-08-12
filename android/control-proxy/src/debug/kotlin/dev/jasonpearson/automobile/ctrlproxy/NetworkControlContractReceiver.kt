package dev.jasonpearson.automobile.ctrlproxy

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.jasonpearson.automobile.sdk.network.NetworkMockRuleStore

/** Debug-only trigger for the emulator contract test. */
class NetworkControlContractReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_SEND_NETWORK_CONTROL) return

    context.sendBroadcast(
      Intent(NetworkMockRuleStore.ACTION_NETWORK_ERROR_SIMULATION).apply {
        putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_ENABLED, true)
        putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_TYPE, ERROR_TYPE)
        putExtra(NetworkMockRuleStore.EXTRA_ERROR_SIM_EXPIRES_AT, Long.MAX_VALUE)
      }
    )
  }

  companion object {
    const val ACTION_SEND_NETWORK_CONTROL =
      "dev.jasonpearson.automobile.ctrlproxy.action.TEST_SEND_NETWORK_CONTROL"
    const val ERROR_TYPE = "ctrlproxy-v2"
  }
}
