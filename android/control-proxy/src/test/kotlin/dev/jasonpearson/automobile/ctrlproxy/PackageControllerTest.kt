package dev.jasonpearson.automobile.ctrlproxy

import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.ErrorResponse
import dev.jasonpearson.automobile.protocol.InstalledPackagesResult
import dev.jasonpearson.automobile.protocol.LaunchIntentResult
import dev.jasonpearson.automobile.protocol.PackageInfoResult
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class PackageControllerTest {
  private class FakeTimer : TimeProvider {
    override fun currentTimeMillis() = 9_000L
  }

  private class FakeSender : PackageController.ResponseSender {
    var running = true
    val frames = mutableListOf<WebSocketResponse>()

    override fun isRunning() = running

    override suspend fun broadcast(response: WebSocketResponse) {
      frames += response
    }
  }

  private val application = RuntimeEnvironment.getApplication()
  private val sender = FakeSender()
  private val errors = mutableListOf<ErrorResponse>()
  private val controller =
    PackageController(
      packageManager = { application.packageManager },
      currentUserId = { 0 },
      timeProvider = FakeTimer(),
      resultBroadcaster =
        ResultBroadcaster(broadcastError = { errors += it }, logError = { _, _ -> }),
      responseSender = sender,
    )

  private fun install(name: String, system: Boolean = false, launchable: Boolean = false) {
    val info =
      PackageInfo().apply {
        packageName = name
        versionName = "1.2"
        applicationInfo =
          ApplicationInfo().apply {
            packageName = name
            flags = if (system) ApplicationInfo.FLAG_SYSTEM else 0
          }
      }
    val shadow = shadowOf(application.packageManager)
    shadow.installPackage(info)
    if (launchable) {
      shadow.addActivityIfNotPresent(ComponentName(name, "$name.Main"))
      shadow.addIntentFilterForActivity(
        ComponentName(name, "$name.Main"),
        android.content.IntentFilter(Intent.ACTION_MAIN).apply {
          addCategory(Intent.CATEGORY_LAUNCHER)
        },
      )
    }
  }

  @Test
  fun `a request for another user is refused with the ADB fallback text`() = runTest {
    controller.performInstalledPackages("r1", includeSystem = true, userId = 10)

    val frame = sender.frames.single() as InstalledPackagesResult
    assertFalse(frame.success)
    assertEquals(0, frame.userId)
    assertTrue(frame.packages.isEmpty())
    assertEquals(
      "Requested userId=10 differs from service userId=0; ADB fallback required",
      frame.error,
    )
    assertEquals(9_000L, frame.timestamp)
  }

  @Test
  fun `installed packages hide system apps unless asked to include them`() = runTest {
    install("com.example.user")
    install("com.example.system", system = true)

    controller.performInstalledPackages("r1", includeSystem = false, userId = null)
    controller.performInstalledPackages("r2", includeSystem = true, userId = 0)

    val (without, with) = sender.frames.map { it as InstalledPackagesResult }
    assertTrue(without.success)
    assertFalse(without.packages.any { it.packageName == "com.example.system" })
    assertTrue(without.packages.any { it.packageName == "com.example.user" && !it.isSystem })
    assertTrue(with.packages.any { it.packageName == "com.example.system" && it.isSystem })
  }

  @Test
  fun `package info reports an unknown package with the existing text`() = runTest {
    controller.performPackageInfo("r1", "com.missing", includePermissions = false)

    val frame = sender.frames.single() as PackageInfoResult
    assertFalse(frame.success)
    assertEquals("Package not installed or not visible: com.missing", frame.error)
    assertTrue(frame.requestedPermissions.isEmpty())
  }

  @Test
  fun `package info reads version and launcher activity for an installed package`() = runTest {
    install("com.example.app", launchable = true)

    controller.performPackageInfo("r1", "com.example.app", includePermissions = false)

    val frame = sender.frames.single() as PackageInfoResult
    assertTrue(frame.success)
    assertEquals("1.2", frame.versionName)
    assertEquals("com.example.app/.Main", frame.mainActivity)
  }

  @Test
  fun `launch intent fails when the package has no launcher activity`() = runTest {
    install("com.example.noui")

    controller.performLaunchIntent("r1", "com.example.noui")

    val frame = sender.frames.single() as LaunchIntentResult
    assertFalse(frame.success)
    assertNull(frame.componentName)
    assertEquals("No launch intent for com.example.noui", frame.error)
  }

  @Test
  fun `nothing is sent while the socket server is not running`() = runTest {
    sender.running = false

    controller.performLaunchIntent("r1", "com.example.noui")

    assertTrue(sender.frames.isEmpty())
  }
}
