package dev.jasonpearson.automobile.sdk

import android.app.NotificationManager
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import java.io.File
import kotlin.test.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Pins the outcome [AutoMobileNotifications.postWithContext] reports, so a bigPicture notification
 * whose image could not be loaded (and so fell back to big text) is distinguishable from a fully
 * successful post (#10014).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [Build.VERSION_CODES.TIRAMISU])
// Native graphics decode real bytes; the legacy BitmapFactory shadow returns a bitmap even for
// undecodable data, which would mask the image-load failure this suite pins.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AutoMobileNotificationsPostResultTest {

  private val context: Context = RuntimeEnvironment.getApplication()

  private fun post(style: NotificationStyle, imagePath: String?): NotificationPostResult =
    AutoMobileNotifications.postWithContext(
      context,
      title = "Title",
      body = "Body",
      style = style,
      imagePath = imagePath,
      actions = emptyList(),
      channelId = null,
    )

  private fun postedCount(): Int {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return shadowOf(manager).allNotifications.size
  }

  @Test
  fun `bigPicture with a nonexistent image path posts without the image`() {
    val result = post(NotificationStyle.BIG_PICTURE, "/nonexistent/automobile/missing.png")

    assertEquals(NotificationPostResult.POSTED_WITHOUT_IMAGE, result)
    // The fallback big-text notification is still posted.
    assertEquals(1, postedCount())
  }

  @Test
  fun `bigPicture with no image path posts without the image`() {
    assertEquals(
      NotificationPostResult.POSTED_WITHOUT_IMAGE,
      post(NotificationStyle.BIG_PICTURE, null),
    )
  }

  @Test
  fun `bigPicture with a loadable image is a full success`() {
    val file = File.createTempFile("automobile-notification", ".png")
    try {
      val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
      file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }

      assertEquals(NotificationPostResult.POSTED, post(NotificationStyle.BIG_PICTURE, file.path))
    } finally {
      file.delete()
    }
  }

  @Test
  fun `non-bigPicture styles ignore the image path and are full successes`() {
    assertEquals(
      NotificationPostResult.POSTED,
      post(NotificationStyle.DEFAULT, "/nonexistent/automobile/missing.png"),
    )
    assertEquals(
      NotificationPostResult.POSTED,
      post(NotificationStyle.BIG_TEXT, "/nonexistent/automobile/missing.png"),
    )
  }
}
