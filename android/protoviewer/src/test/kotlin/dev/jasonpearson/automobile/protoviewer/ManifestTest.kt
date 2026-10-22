package dev.jasonpearson.automobile.protoviewer

import android.content.ComponentName
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ManifestTest {
  @Test
  fun mergedManifestIsUnprivileged() {
    val context = ApplicationProvider.getApplicationContext<Context>()
    val info =
      context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
    assertEquals(setOf("android.permission.INTERNET"), info.requestedPermissions.orEmpty().toSet())
    val viewer =
      context.packageManager.getActivityInfo(ComponentName(context, ViewerActivity::class.java), 0)
    assertFalse(viewer.exported)
    assertEquals(android.content.pm.ActivityInfo.DOCUMENT_LAUNCH_ALWAYS, viewer.documentLaunchMode)
    assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
    assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_USES_CLEARTEXT_TRAFFIC)
  }
}
