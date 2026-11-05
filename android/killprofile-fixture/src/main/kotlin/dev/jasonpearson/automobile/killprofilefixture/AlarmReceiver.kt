package dev.jasonpearson.automobile.killprofilefixture

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val event = SurvivalEventId.valueOf(requireNotNull(intent.getStringExtra("event")))
    SurvivalEvents.append(context, event)
  }
}
