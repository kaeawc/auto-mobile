package dev.jasonpearson.automobile.killprofilefixture

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
      SurvivalEvents.append(context, SurvivalEventId.BOOT_RECEIVER)
    }
  }
}
