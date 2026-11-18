package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.Manifest
import android.app.Application
import android.location.Location
import android.location.LocationManager
import android.os.Looper
import android.os.SystemClock
import dev.jasonpearson.automobile.prototype.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLocationManager

/** API 26 is in the 24-27 range where network-only location mode leaves GPS disabled. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26])
class AndroidLocationProvidersTest {
  private lateinit var app: Application
  private lateinit var manager: LocationManager
  private lateinit var shadow: ShadowLocationManager

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication()
    // ContextCompat's pre-33 not-exported receivers need androidx's signature permission, which a
    // device grants at install and Robolectric does not.
    shadowOf(app)
      .grantPermissions(
        Manifest.permission.ACCESS_FINE_LOCATION,
        "${app.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
      )
    manager = app.getSystemService(LocationManager::class.java)
    shadow = shadowOf(manager)
    shadow.setProviderEnabled(LocationManager.GPS_PROVIDER, false)
    shadow.setProviderEnabled(LocationManager.NETWORK_PROVIDER, true)
    idle()
  }

  private fun idle() = shadowOf(Looper.getMainLooper()).idle()

  private fun location(provider: String, latitude: Double) =
    Location(provider).apply {
      this.latitude = latitude
      longitude = -93.0
      accuracy = 5f
      time = 1234
      elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
    }

  @Test
  fun `network-only mode subscribes a precise request to network, not the disabled gps`() =
    runTest {
      val source = AndroidLocationSource(app)
      assertTrue(source.servicesEnabled.value)
      val fixes = mutableListOf<LocationFix>()
      backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
        source.updates(PrototypeLocationAccuracy.PRECISE, 1000, 0.0).collect { fixes += it }
      }
      shadow.simulateLocation(location(LocationManager.GPS_PROVIDER, 1.0))
      shadow.simulateLocation(location(LocationManager.NETWORK_PROVIDER, 2.0))
      idle()
      runCurrent()
      assertEquals(listOf(2.0), fixes.map { it.latitude })
      source.close()
    }

  @Test
  fun `provider toggles move a live subscription to the provider left enabled`() = runTest {
    val source = AndroidLocationSource(app)
    val fixes = mutableListOf<LocationFix>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      source.updates(PrototypeLocationAccuracy.PRECISE, 1000, 0.0).collect { fixes += it }
    }
    shadow.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
    idle()
    runCurrent()
    shadow.setProviderEnabled(LocationManager.NETWORK_PROVIDER, false)
    idle()
    runCurrent()
    assertTrue(source.servicesEnabled.value)
    shadow.simulateLocation(location(LocationManager.NETWORK_PROVIDER, 1.0))
    shadow.simulateLocation(location(LocationManager.GPS_PROVIDER, 3.0))
    idle()
    runCurrent()
    assertEquals(listOf(3.0), fixes.map { it.latitude })
    source.close()
  }

  @Test
  fun `a pending request ends disabled when the last provider turns off`() = runTest {
    val source = AndroidLocationSource(app)
    val module = PrototypeLocationModule(source, scope = backgroundScope)
    val request =
      PlatformCall("c", "location.request", buildJsonObject { put("accuracy", "precise") })
    val result = async(UnconfinedTestDispatcher(testScheduler)) { module.call(request) }
    idle()
    runCurrent()
    assertFalse(result.isCompleted)
    shadow.setProviderEnabled(LocationManager.NETWORK_PROVIDER, false)
    idle()
    runCurrent()
    assertFalse(source.servicesEnabled.value)
    val error = (result.getCompleted() as PlatformCallResult.Failure).error
    assertEquals(PlatformErrorCode.UNAVAILABLE, error.code)
    assertEquals("disabled", error.reason)
    module.close()
  }

  @Test
  fun `services read before the grant still report enabled providers after it`() = runTest {
    shadowOf(app).denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
    val source = AndroidLocationSource(app)
    assertTrue(source.servicesEnabled.value)
    shadowOf(app).grantPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
    val fixes = mutableListOf<LocationFix>()
    backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
      source.updates(PrototypeLocationAccuracy.PRECISE, 1000, 0.0).collect { fixes += it }
    }
    shadow.simulateLocation(location(LocationManager.NETWORK_PROVIDER, 2.0))
    idle()
    runCurrent()
    assertEquals(listOf(2.0), fixes.map { it.latitude })
    source.close()
  }
}
