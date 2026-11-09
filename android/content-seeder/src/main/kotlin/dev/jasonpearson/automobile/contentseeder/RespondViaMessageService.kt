package dev.jasonpearson.automobile.contentseeder

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log

class RespondViaMessageService : Service() {
  override fun onBind(intent: Intent): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Log.i("ContentSeeder", "Respond-via-message is unsupported by this fixture app")
    stopSelf(startId)
    return START_NOT_STICKY
  }
}
