package dev.jasonpearson.automobile.sdk.notifications

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dev.jasonpearson.automobile.sdk.AutoMobileNotifications
import dev.jasonpearson.automobile.sdk.NotificationAction
import dev.jasonpearson.automobile.sdk.NotificationStyle
import org.json.JSONArray

class AutoMobileNotificationReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    if (intent?.action != AutoMobileNotifications.ACTION_POST_NOTIFICATION) {
      return
    }

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

      val success =
        AutoMobileNotifications.postWithContext(
          context,
          title,
          body,
          style,
          imagePath,
          actions,
          channelId,
        )

      resultCode = if (success) RESULT_SUCCESS else RESULT_ERROR
    } catch (e: Exception) {
      Log.e(TAG, "Failed to handle notification request", e)
      resultCode = RESULT_ERROR
    }
  }

  private fun parseActions(actionsJson: String?): List<NotificationAction> {
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
    } catch (e: Exception) {
      Log.w(TAG, "Failed to parse notification actions", e)
      emptyList()
    }
  }

  companion object {
    private const val TAG = "AutoMobileNotifReceiver"
    private const val RESULT_SUCCESS = 1
    private const val RESULT_ERROR = 0
  }
}
