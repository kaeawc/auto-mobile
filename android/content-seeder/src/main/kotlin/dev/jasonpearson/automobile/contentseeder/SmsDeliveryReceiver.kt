package dev.jasonpearson.automobile.contentseeder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

open class SmsDeliveryReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    Log.i("ContentSeeder", "Ignoring live delivery ${intent.action}; this app only seeds fixtures")
  }
}

class MmsDeliveryReceiver : SmsDeliveryReceiver()
