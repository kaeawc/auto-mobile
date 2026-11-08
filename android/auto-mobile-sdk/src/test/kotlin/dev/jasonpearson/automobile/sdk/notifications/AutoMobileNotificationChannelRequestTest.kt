package dev.jasonpearson.automobile.sdk.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import dev.jasonpearson.automobile.sdk.AutoMobileNotifications
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Pins the host channel requests keep-booted reset uses to revert a channel a session's
 * postNotification created (#16510): result 3 means absent after the action, 4 present, 0 failed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.TIRAMISU])
class AutoMobileNotificationChannelRequestTest {

  private val context: Context = RuntimeEnvironment.getApplication()
  private val manager =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
  private val receiver = AutoMobileNotificationReceiver()

  private fun request(action: String, channelId: String?): Int =
    receiver.channelResultCode(
      context,
      Intent(action).apply {
        channelId?.let { putExtra(AutoMobileNotifications.EXTRA_CHANNEL_ID, it) }
      },
    )

  private fun createChannel(id: String) {
    manager.createNotificationChannel(
      NotificationChannel(id, id, NotificationManager.IMPORTANCE_DEFAULT),
    )
  }

  @Test
  fun `query reports whether the channel exists`() {
    assertEquals(3, request(AutoMobileNotificationReceiver.ACTION_CHANNEL_QUERY, "session_channel"))
    createChannel("session_channel")
    assertEquals(4, request(AutoMobileNotificationReceiver.ACTION_CHANNEL_QUERY, "session_channel"))
  }

  @Test
  fun `delete removes only the named channel and reports it absent`() {
    createChannel("session_channel")
    createChannel("app_channel")

    assertEquals(
      3,
      request(AutoMobileNotificationReceiver.ACTION_CHANNEL_DELETE, "session_channel"),
    )

    assertNull(manager.getNotificationChannel("session_channel"))
    assertNotNull(manager.getNotificationChannel("app_channel"))
    assertEquals(3, request(AutoMobileNotificationReceiver.ACTION_CHANNEL_QUERY, "session_channel"))
  }

  @Test
  fun `a request without a channel id fails`() {
    assertEquals(0, request(AutoMobileNotificationReceiver.ACTION_CHANNEL_DELETE, null))
    assertEquals(0, request(AutoMobileNotificationReceiver.ACTION_CHANNEL_QUERY, " "))
  }
}
