package dev.jasonpearson.automobile.killprofilefixture

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

class SurvivalForegroundService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private val heartbeat =
    object : Runnable {
      override fun run() {
        SurvivalEvents.append(this@SurvivalForegroundService, SurvivalEventId.FOREGROUND_SERVICE)
        handler.postDelayed(this, HEARTBEAT_MS)
      }
    }

  override fun onCreate() {
    super.onCreate()
    getSystemService(NotificationManager::class.java)
      .createNotificationChannel(
        NotificationChannel(
          "survival",
          getString(R.string.channel_name),
          NotificationManager.IMPORTANCE_LOW,
        ),
      )
    startForeground(
      1,
      Notification.Builder(this, "survival")
        .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle(getString(R.string.notification_title))
        .build(),
    )
    wakeLock =
      getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:survival")
        .apply { acquire(MAX_RUN_MS) }
    handler.postDelayed(heartbeat, HEARTBEAT_MS)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

  override fun onDestroy() {
    handler.removeCallbacks(heartbeat)
    wakeLock?.let { if (it.isHeld) it.release() }
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private companion object {
    const val HEARTBEAT_MS = 30_000L
    // Bound accidental runs; longer than the host's primary and recovery observation windows.
    const val MAX_RUN_MS = 30 * 60_000L
  }
}
