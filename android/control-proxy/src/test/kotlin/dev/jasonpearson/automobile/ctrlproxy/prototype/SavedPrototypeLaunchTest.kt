package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SavedPrototypeLaunchTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  @Test
  fun `explicit document intent uses an encoded id and never reads extras`() {
    for (id in listOf("panel", "a/b", "a b?#%", "你好", "a+b")) {
      val intent = SavedPrototypeLaunch.intent(context, id).putExtra("id", "other")
      assertEquals(SavedPrototypeActivity::class.java.name, intent.component?.className)
      assertEquals("automobile-saved-prototype", intent.data?.scheme)
      assertEquals(listOf(id), intent.data?.pathSegments)
      assertEquals(Intent.FLAG_ACTIVITY_NEW_DOCUMENT, intent.flags)
      assertEquals(id, SavedPrototypeLaunch.idFrom(intent))
    }
    assertNull(SavedPrototypeLaunch.idFrom(Intent().putExtra("id", "panel")))
  }

  @Test
  fun `invalid data has no usable id`() {
    assertNull(SavedPrototypeLaunch.idFrom(null))
    for (uri in
      listOf(
        "automobile-saved-prototype:/",
        "automobile-saved-prototype:/%20",
        "other:/panel",
        "automobile-saved-prototype:/a/b",
        "automobile-saved-prototype:/a/",
        "automobile-saved-prototype://host/panel",
      )) {
      assertNull(uri, SavedPrototypeLaunch.idFrom(Intent().setData(Uri.parse(uri))))
    }
  }

  @Test
  fun `document equality distinguishes ids but ignores extras`() {
    val first = SavedPrototypeLaunch.intent(context, "first")
    assertFalse(first.filterEquals(SavedPrototypeLaunch.intent(context, "second")))
    assertTrue(
      first.filterEquals(SavedPrototypeLaunch.intent(context, "first").putExtra("id", "second")),
    )
  }

  @Test
  fun `manifest keeps activity private with no implicit data entry point`() {
    val explicit = SavedPrototypeLaunch.intent(context, "panel")
    val info = context.packageManager.getActivityInfo(checkNotNull(explicit.component), 0)
    assertFalse(info.exported)
    assertEquals(
      android.content.pm.ActivityInfo.DOCUMENT_LAUNCH_INTO_EXISTING,
      info.documentLaunchMode,
    )
    val implicit = Intent(Intent.ACTION_VIEW, explicit.data).setPackage(context.packageName)
    assertTrue(
      context.packageManager.queryIntentActivities(implicit, PackageManager.MATCH_ALL).isEmpty(),
    )
  }
}
