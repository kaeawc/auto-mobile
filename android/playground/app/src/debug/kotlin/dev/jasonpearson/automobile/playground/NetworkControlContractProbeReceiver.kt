package dev.jasonpearson.automobile.playground

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dev.jasonpearson.automobile.sdk.network.NetworkMockRuleStore

/** Debug-only probe for the emulator permission-delivery contract test. */
class NetworkControlContractProbeReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_PROBE_NETWORK_CONTROL) return

    val errorType = NetworkMockRuleStore.getInstance().getActiveErrorSimulation()?.errorType.orEmpty()
    context.openFileOutput(RESULT_FILE, Context.MODE_PRIVATE).bufferedWriter().use { writer ->
      writer.write(errorType)
    }
  }

  companion object {
    const val ACTION_PROBE_NETWORK_CONTROL =
      "dev.jasonpearson.automobile.playground.action.TEST_PROBE_NETWORK_CONTROL"
    const val RESULT_FILE = "automobile-network-control-contract-result"
  }
}
