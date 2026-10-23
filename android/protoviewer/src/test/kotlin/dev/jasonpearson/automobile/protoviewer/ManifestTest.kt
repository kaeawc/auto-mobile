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
    assertEquals(
      setOf("android.permission.INTERNET", "android.permission.ACCESS_LOCAL_NETWORK"),
      info.requestedPermissions.orEmpty().toSet(),
    )
    val viewer =
      context.packageManager.getActivityInfo(ComponentName(context, ViewerActivity::class.java), 0)
    val importer =
      context.packageManager.getActivityInfo(ComponentName(context, ImportActivity::class.java), 0)
    assertTrue(importer.exported)
    assertTrue(importer.taskAffinity.isNullOrEmpty())
    assertTrue(importer.flags and android.content.pm.ActivityInfo.FLAG_EXCLUDE_FROM_RECENTS != 0)
    val provider =
      context.packageManager.resolveContentProvider(
        "${context.packageName}.exports",
        PackageManager.GET_META_DATA,
      )!!
    assertFalse(provider.exported)
    assertTrue(provider.grantUriPermissions)
    val paths =
      context.resources.getXml(provider.metaData.getInt("android.support.FILE_PROVIDER_PATHS"))
    var cachePaths = 0
    while (paths.eventType != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
      if (paths.eventType == org.xmlpull.v1.XmlPullParser.START_TAG && paths.name != "paths") {
        assertEquals("cache-path", paths.name)
        assertEquals("export/", paths.getAttributeValue(null, "path"))
        cachePaths++
      }
      paths.next()
    }
    paths.close()
    assertEquals(1, cachePaths)
    val mcp =
      context.packageManager.getActivityInfo(ComponentName(context, McpActivity::class.java), 0)
    // Only the adb shell holds DUMP, so no app can start the MCP entry; its actions resolve
    // nowhere.
    assertTrue(mcp.exported)
    assertEquals("android.permission.DUMP", mcp.permission)
    for (action in listOf(MCP_IMPORT_ACTION, MCP_OPEN_ACTION)) {
      val implicit = android.content.Intent(action).setPackage(context.packageName)
      assertTrue(context.packageManager.queryIntentActivities(implicit, 0).isEmpty())
    }
    assertFalse(viewer.exported)
    assertEquals(android.content.pm.ActivityInfo.DOCUMENT_LAUNCH_ALWAYS, viewer.documentLaunchMode)
    assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_ALLOW_BACKUP)
    assertEquals(0, context.applicationInfo.flags and ApplicationInfo.FLAG_USES_CLEARTEXT_TRAFFIC)
  }
}
