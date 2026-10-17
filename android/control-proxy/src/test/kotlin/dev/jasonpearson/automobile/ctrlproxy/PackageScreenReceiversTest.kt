package dev.jasonpearson.automobile.ctrlproxy

import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class PackageScreenReceiversTest {
  private val context = RuntimeEnvironment.getApplication()

  private class FakePackageHost(private val system: Boolean? = true) : PackageEventHost {
    val events = mutableListOf<PackageBroadcastEvent>()
    val lookups = mutableListOf<String>()

    override fun isSystemApp(packageName: String): Boolean? {
      lookups += packageName
      return system
    }

    override suspend fun onPackageEvent(event: PackageBroadcastEvent) {
      events += event
    }
  }

  private fun packageIntent(action: String, uid: Int? = null, replacing: Boolean = false) =
    Intent(action, Uri.parse("package:com.app")).apply {
      uid?.let { putExtra(Intent.EXTRA_UID, it) }
      putExtra(Intent.EXTRA_REPLACING, replacing)
    }

  @Test
  fun `an added package reports its user id uid and system flag`() = runTest {
    val host = FakePackageHost(system = false)
    val receiver =
      PackageEventReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(context, packageIntent(Intent.ACTION_PACKAGE_ADDED, uid = 1010234))

    val event = host.events.single()
    assertEquals("added", event.action)
    assertEquals("com.app", event.packageName)
    assertEquals(10, event.userId)
    assertEquals(1010234, event.uid)
    assertEquals(false, event.isSystem)
  }

  @Test
  fun `a removal skips the system lookup and a missing uid reports the primary user`() = runTest {
    val host = FakePackageHost()
    val receiver =
      PackageEventReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(context, packageIntent(Intent.ACTION_PACKAGE_REMOVED))

    val event = host.events.single()
    assertEquals("removed", event.action)
    assertNull(event.isSystem)
    assertNull(event.uid)
    assertEquals(0, event.userId)
    assertTrue(host.lookups.isEmpty())
  }

  @Test
  fun `replacement broadcasts collapse into a single replaced event`() = runTest {
    val host = FakePackageHost()
    val receiver =
      PackageEventReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(context, packageIntent(Intent.ACTION_PACKAGE_ADDED, replacing = true))
    receiver.onReceive(context, packageIntent(Intent.ACTION_PACKAGE_REMOVED, replacing = true))
    receiver.onReceive(context, packageIntent(Intent.ACTION_PACKAGE_REPLACED))

    assertEquals(listOf("replaced", "replaced"), host.events.map { it.action })
  }

  @Test
  fun `unrelated null or dataless package broadcasts are ignored`() = runTest {
    val host = FakePackageHost()
    val receiver =
      PackageEventReceiver(CoroutineScope(UnconfinedTestDispatcher(testScheduler)), host)

    receiver.onReceive(context, null)
    receiver.onReceive(context, Intent("other.action", Uri.parse("package:com.app")))
    receiver.onReceive(context, Intent(Intent.ACTION_PACKAGE_ADDED))

    assertTrue(host.events.isEmpty())
  }

  private class FakeScreenHost : ScreenStateHost {
    var refreshes = 0
    var extractions = 0

    override fun refreshPrototypeWindow() {
      refreshes++
    }

    override fun extractHierarchyNow() {
      extractions++
    }
  }

  @Test
  fun `screen on and off refresh the prototype and extract the hierarchy`() {
    val host = FakeScreenHost()
    val receiver = ScreenStateReceiver(host)

    receiver.onReceive(context, Intent(Intent.ACTION_SCREEN_ON))
    receiver.onReceive(context, Intent(Intent.ACTION_SCREEN_OFF))

    assertEquals(2, host.refreshes)
    assertEquals(2, host.extractions)
  }

  @Test
  fun `other screen actions only refresh the prototype`() {
    val host = FakeScreenHost()
    val receiver = ScreenStateReceiver(host)

    receiver.onReceive(context, Intent(Intent.ACTION_USER_PRESENT))
    receiver.onReceive(context, null)

    assertEquals(2, host.refreshes)
    assertEquals(0, host.extractions)
  }
}
