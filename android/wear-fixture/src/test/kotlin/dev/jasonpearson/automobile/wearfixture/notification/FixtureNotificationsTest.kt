package dev.jasonpearson.automobile.wearfixture.notification

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.app.PendingIntent
import androidx.wear.ongoing.OngoingActivity
import dev.jasonpearson.automobile.wearfixture.WearFixtureCatalog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

// Robolectric supplies the notification manager, PendingIntent and the ongoing-activity extras.
@RunWith(RobolectricTestRunner::class)
class FixtureNotificationsTest {
  private val app: Application = RuntimeEnvironment.getApplication()
  private val manager = app.getSystemService(NotificationManager::class.java)
  private val notifications = FixtureNotifications(app)

  @Test
  fun `alert carries two actions in catalog order`() {
    shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)

    assertTrue(notifications.postAlert())

    val posted = shadowOf(manager).getNotification(WearFixtureCatalog.ALERT_NOTIFICATION_ID)
    assertEquals(listOf("Reply", "Archive"), posted.actions.map { it.title.toString() })
    assertNotNull(manager.getNotificationChannel(WearFixtureCatalog.CHANNEL_ID))
  }

  @Test
  fun `only reply has a remote input and a mutable pending intent`() {
    shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)

    assertTrue(notifications.postAlert())

    val posted = shadowOf(manager).getNotification(WearFixtureCatalog.ALERT_NOTIFICATION_ID)
    val reply = posted.actions[0]
    val archive = posted.actions[1]
    val input = reply.remoteInputs.single()
    assertEquals(WearFixtureCatalog.REPLY_INPUT_KEY, input.resultKey)
    assertEquals("Reply", input.label.toString())
    assertTrue(input.allowFreeFormInput)
    assertNull(archive.remoteInputs)
    assertEquals(
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
      shadowOf(reply.actionIntent).flags,
    )
    assertEquals(
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      shadowOf(archive.actionIntent).flags,
    )
  }

  @Test
  fun `ongoing activity is attached to an ongoing notification and stops on request`() {
    shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)

    assertTrue(notifications.startOngoing())

    val posted = shadowOf(manager).getNotification(WearFixtureCatalog.ONGOING_NOTIFICATION_ID)
    assertNotNull(OngoingActivity.recoverOngoingActivity(app))
    assertTrue(posted.flags and android.app.Notification.FLAG_ONGOING_EVENT != 0)

    notifications.stopOngoing()
    assertTrue(shadowOf(manager).allNotifications.isEmpty())
  }

  @Test
  fun `nothing is posted without the notification permission`() {
    shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)

    assertFalse(notifications.postAlert())
    assertFalse(notifications.startOngoing())
    assertTrue(shadowOf(manager).allNotifications.isEmpty())
  }
}
