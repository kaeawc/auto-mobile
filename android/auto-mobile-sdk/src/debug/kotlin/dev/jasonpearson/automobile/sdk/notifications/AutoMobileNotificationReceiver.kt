package dev.jasonpearson.automobile.sdk.notifications

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.annotation.VisibleForTesting
import dev.jasonpearson.automobile.sdk.AutoMobileNotifications
import dev.jasonpearson.automobile.sdk.NotificationAction
import dev.jasonpearson.automobile.sdk.NotificationPostResult
import dev.jasonpearson.automobile.sdk.NotificationStyle
import org.json.JSONArray
import org.json.JSONException

class AutoMobileNotificationReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    when (intent?.action) {
      AutoMobileNotifications.ACTION_POST_NOTIFICATION -> post(context, intent)
      ACTION_CHANNEL_QUERY,
      ACTION_CHANNEL_DELETE -> resultCode = channelResultCode(context, intent)
    }
  }

  /**
   * Answers a host channel request with the channel's state after the action: 3 absent, 4 present,
   * 0 when the request names no channel or the action failed.
   */
  @VisibleForTesting
  internal fun channelResultCode(context: Context, intent: Intent): Int {
    val channelId = intent.getStringExtra(AutoMobileNotifications.EXTRA_CHANNEL_ID)
    if (channelId.isNullOrBlank()) {
      Log.w(TAG, "Missing channel id in notification channel request")
      return RESULT_ERROR
    }
    return try {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (
        intent.action == ACTION_CHANNEL_DELETE && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
      ) {
        manager.deleteNotificationChannel(channelId)
      }
      val exists =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          manager.getNotificationChannel(channelId) != null
      if (exists) RESULT_CHANNEL_PRESENT else RESULT_CHANNEL_ABSENT
    } catch (e: Exception) {
      Log.e(TAG, "Failed to handle notification channel request", e)
      RESULT_ERROR
    }
  }

  private fun post(context: Context, intent: Intent) {
    try {
      val title = intent.getStringExtra(AutoMobileNotifications.EXTRA_TITLE).orEmpty()
      val body = intent.getStringExtra(AutoMobileNotifications.EXTRA_BODY).orEmpty()
      if (title.isBlank() || body.isBlank()) {
        Log.w(TAG, "Missing title/body in notification request")
        resultCode = RESULT_ERROR
        return
      }

      val style =
        NotificationStyle.fromWireName(intent.getStringExtra(AutoMobileNotifications.EXTRA_STYLE))
      val imagePath = intent.getStringExtra(AutoMobileNotifications.EXTRA_IMAGE_PATH)
      val channelId = intent.getStringExtra(AutoMobileNotifications.EXTRA_CHANNEL_ID)
      val actionsJson = intent.getStringExtra(AutoMobileNotifications.EXTRA_ACTIONS)
      val actions = parseActions(actionsJson)

      val result =
        AutoMobileNotifications.postWithContext(
          context,
          title,
          body,
          style,
          imagePath,
          actions,
          channelId,
        )

      resultCode = resultCodeFor(result)
    } catch (e: Exception) {
      Log.e(TAG, "Failed to handle notification request", e)
      resultCode = RESULT_ERROR
    }
  }

  /**
   * Maps a post outcome to the broadcast result code the host reads: 1 posted, 2 posted but the
   * bigPicture image could not be loaded, 0 not posted.
   */
  @VisibleForTesting
  internal fun resultCodeFor(result: NotificationPostResult): Int =
    when (result) {
      NotificationPostResult.POSTED -> RESULT_SUCCESS
      NotificationPostResult.POSTED_WITHOUT_IMAGE -> RESULT_POSTED_WITHOUT_IMAGE
      NotificationPostResult.FAILED -> RESULT_ERROR
    }

  @VisibleForTesting
  internal fun parseActions(actionsJson: String?): List<NotificationAction> {
    if (actionsJson.isNullOrBlank()) return emptyList()
    return try {
      val array = JSONArray(actionsJson)
      (0 until array.length()).mapNotNull { i ->
        val obj = array.optJSONObject(i) ?: return@mapNotNull null
        val label = obj.optString("label")
        val actionId = obj.optString("actionId")
        if (label.isNotBlank() && actionId.isNotBlank()) {
          NotificationAction(label = label, actionId = actionId)
        } else {
          null
        }
      }
    } catch (e: JSONException) {
      Log.w(TAG, "Failed to parse notification actions", e)
      emptyList()
    }
  }

  companion object {
    /** Host query: does the channel named by the channel id extra exist? */
    internal const val ACTION_CHANNEL_QUERY =
      "dev.jasonpearson.automobile.sdk.NOTIFICATION_CHANNEL_QUERY"

    /** Host request: delete the channel named by the channel id extra, then report its state. */
    internal const val ACTION_CHANNEL_DELETE =
      "dev.jasonpearson.automobile.sdk.NOTIFICATION_CHANNEL_DELETE"

    private const val TAG = "AutoMobileNotifReceiver"
    private const val RESULT_SUCCESS = 1
    private const val RESULT_POSTED_WITHOUT_IMAGE = 2
    private const val RESULT_ERROR = 0
    private const val RESULT_CHANNEL_ABSENT = 3
    private const val RESULT_CHANNEL_PRESENT = 4
  }
}
