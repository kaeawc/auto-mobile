package dev.jasonpearson.automobile.killprofilefixture

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class PushReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == "dev.jasonpearson.automobile.killprofilefixture.PUSH") {
      SurvivalEvents.append(context, SurvivalEventId.PUSH_BROADCAST)
    }
  }
}
