package dev.jasonpearson.automobile.wearfixture.notification

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import androidx.wear.ongoing.OngoingActivity
import androidx.wear.ongoing.Status
import dev.jasonpearson.automobile.wearfixture.LaunchRequest
import dev.jasonpearson.automobile.wearfixture.MainActivity
import dev.jasonpearson.automobile.wearfixture.R
import dev.jasonpearson.automobile.wearfixture.WearFixtureCatalog

/**
 * Posts the fixture's notification (inline reply and archive actions) and its ongoing activity.
 * Both are local; nothing waits on a network or an account.
 */
class FixtureNotifications(private val context: Context) {
  private val manager = NotificationManagerCompat.from(context)

  fun canPost(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
        PackageManager.PERMISSION_GRANTED

  /** Returns false when the notification permission is missing and nothing was posted. */
  fun postAlert(): Boolean {
    if (!canPost()) return false
    ensureChannel()
    val builder =
      NotificationCompat.Builder(context, WearFixtureCatalog.CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_ongoing)
        .setContentTitle(WearFixtureCatalog.ALERT_TITLE)
        .setContentText(WearFixtureCatalog.ALERT_TEXT)
        .setContentIntent(openApp(REQUEST_ALERT_CONTENT, null))
        .setAutoCancel(true)
    WearFixtureCatalog.notificationActions.forEachIndexed { index, action ->
      builder.addAction(
        NotificationCompat.Action.Builder(
            R.drawable.ic_ongoing,
            action.label,
            openApp(REQUEST_ALERT_ACTION + index, action.id),
          )
          .apply {
            if (action.id == "reply") {
              addRemoteInput(
                RemoteInput.Builder(WearFixtureCatalog.REPLY_INPUT_KEY)
                  .setLabel(action.label)
                  .build(),
              )
            }
          }
          .build(),
      )
    }
    notify(WearFixtureCatalog.ALERT_NOTIFICATION_ID, builder)
    return true
  }

  /** Returns false when the notification permission is missing and nothing was posted. */
  fun startOngoing(): Boolean {
    if (!canPost()) return false
    ensureChannel()
    val touchIntent = openApp(REQUEST_ONGOING, null)
    val builder =
      NotificationCompat.Builder(context, WearFixtureCatalog.CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_ongoing)
        .setContentTitle(WearFixtureCatalog.ONGOING_TITLE)
        .setContentText(WearFixtureCatalog.ONGOING_STATUS)
        .setCategory(NotificationCompat.CATEGORY_STOPWATCH)
        .setContentIntent(touchIntent)
        .setOngoing(true)
    OngoingActivity.Builder(context, WearFixtureCatalog.ONGOING_NOTIFICATION_ID, builder)
      .setStaticIcon(R.drawable.ic_ongoing)
      .setTouchIntent(touchIntent)
      .setStatus(Status.Builder().addTemplate(WearFixtureCatalog.ONGOING_STATUS).build())
      .build()
      .apply(context)
    notify(WearFixtureCatalog.ONGOING_NOTIFICATION_ID, builder)
    return true
  }

  fun stopOngoing() {
    manager.cancel(WearFixtureCatalog.ONGOING_NOTIFICATION_ID)
  }

  private fun notify(id: Int, builder: NotificationCompat.Builder) {
    // Lint cannot follow the canPost() guard here, so the call carries the suppression.
    if (canPost()) {
      @Suppress("MissingPermission") manager.notify(id, builder.build())
    }
  }

  private fun ensureChannel() {
    val channel =
      NotificationChannel(
        WearFixtureCatalog.CHANNEL_ID,
        WearFixtureCatalog.CHANNEL_NAME,
        NotificationManager.IMPORTANCE_DEFAULT,
      )
    context.getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun openApp(requestCode: Int, actionId: String?): PendingIntent {
    val mutability =
      if (actionId == "reply") PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
    val intent =
      // MainActivity is singleTop, so a running fixture receives this through onNewIntent.
      Intent(context, MainActivity::class.java).apply {
        actionId?.let { putExtra(LaunchRequest.EXTRA_NOTIFICATION_ACTION, it) }
      }
    return PendingIntent.getActivity(
      context,
      requestCode,
      intent,
      mutability or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private companion object {
    const val REQUEST_ALERT_CONTENT = 10
    const val REQUEST_ALERT_ACTION = 20
    const val REQUEST_ONGOING = 30
  }
}
