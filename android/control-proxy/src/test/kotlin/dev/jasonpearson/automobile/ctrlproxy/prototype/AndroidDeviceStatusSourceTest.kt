package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.app.Application
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.BatteryManager
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AndroidDeviceStatusSourceTest {
  private val context = ApplicationProvider.getApplicationContext<Context>()

  private class FakeGateway : AndroidStatusGateway {
    var reading = PrototypeDeviceStatus.power(false, null)
    var reads = 0
    var registrations = 0
    var removals = 0
    var changed: () -> Unit = {}
    var fail = false

    override fun read(): JsonObject {
      reads++
      return reading
    }

    override fun observe(changed: () -> Unit, retain: (() -> Unit) -> Unit) {
      this.changed = changed
      registrations++
      retain { removals++ }
      check(!fail) { "Registration failure" }
    }
  }

  @Test
  fun `lazy source seeds tracks and closes exactly once without restarting`() {
    val gateway = FakeGateway()
    val source = AndroidDeviceStatusSource(gateway)
    assertEquals(0, gateway.reads)
    assertEquals(gateway.reading, source.state.value)
    source.state
    assertEquals(1, gateway.registrations)
    gateway.reading = PrototypeDeviceStatus.power(true, 3)
    gateway.changed()
    assertEquals(gateway.reading, source.state.value)
    source.close()
    source.close()
    val reads = gateway.reads
    gateway.changed()
    source.state
    assertEquals(reads, gateway.reads)
    assertEquals(1, gateway.removals)
  }

  @Test
  fun `close before read registers nothing and failed registration releases partial resources`() {
    val unused = FakeGateway()
    val source = AndroidDeviceStatusSource(unused)
    source.close()
    source.state
    assertEquals(0, unused.reads)
    val failed = FakeGateway().apply { fail = true }
    val failing = AndroidDeviceStatusSource(failed)
    failing.state
    assertEquals(1, failed.removals)
    failing.close()
    assertEquals(1, failed.removals)
  }

  @Test
  fun `battery sticky seed and broadcast refresh use level scale and status`() {
    fun send(level: Int, status: Int) {
      context.sendStickyBroadcast(
        Intent(Intent.ACTION_BATTERY_CHANGED)
          .putExtra(BatteryManager.EXTRA_LEVEL, level)
          .putExtra(BatteryManager.EXTRA_SCALE, 3)
          .putExtra(BatteryManager.EXTRA_STATUS, status),
      )
      shadowOf(Looper.getMainLooper()).idle()
    }
    send(1, BatteryManager.BATTERY_STATUS_CHARGING)
    val source = AndroidBatteryStatusSource(context)
    assertEquals(PrototypeDeviceStatus.battery(1, 3, 2), source.state.value)
    send(2, BatteryManager.BATTERY_STATUS_FULL)
    assertEquals(PrototypeDeviceStatus.battery(2, 3, 5), source.state.value)
    source.close()
    send(0, BatteryManager.BATTERY_STATUS_DISCHARGING)
    assertEquals(PrototypeDeviceStatus.battery(2, 3, 5), source.state.value)
  }

  @Test
  @Config(sdk = [28])
  fun `power below API 29 omits thermal and observes saver broadcasts`() {
    // Before API 33, AndroidX guards non-exported receivers with this signature permission.
    // Grant it to the synthetic sender so Robolectric delivers the saver broadcast.
    shadowOf(context as Application)
      .grantPermissions("${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
    val manager = context.getSystemService(PowerManager::class.java)
    val source = AndroidPowerStatusSource(context)
    assertFalse(source.state.value.containsKey("thermal"))
    assertEquals(JsonPrimitive(false), source.state.value["saver"])
    shadowOf(manager).setIsPowerSaveMode(true)
    assertEquals(JsonPrimitive(false), source.state.value["saver"])
    context.sendBroadcast(Intent(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(JsonPrimitive(true), source.state.value["saver"])
    assertFalse(source.state.value.containsKey("thermal"))
    source.close()
  }

  @Test
  fun `power seeds thermal status and responds to thermal callbacks`() {
    val manager = context.getSystemService(PowerManager::class.java)
    shadowOf(manager).setCurrentThermalStatus(PowerManager.THERMAL_STATUS_LIGHT)
    val source = AndroidPowerStatusSource(context)
    assertEquals(JsonPrimitive("fair"), source.state.value["thermal"])
    assertEquals(1, shadowOf(manager).thermalStatusListeners.size)
    shadowOf(manager).setCurrentThermalStatus(PowerManager.THERMAL_STATUS_SEVERE)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(JsonPrimitive("serious"), source.state.value["thermal"])
    source.close()
    assertTrue(shadowOf(manager).thermalStatusListeners.isEmpty())
  }

  @Test
  fun `audio content observer refreshes media volume and close removes it`() {
    val manager = context.getSystemService(AudioManager::class.java)
    val source = AndroidAudioStatusSource(context)
    source.state
    manager.setStreamVolume(AudioManager.STREAM_MUSIC, 0, 0)
    context.contentResolver.notifyChange(Settings.System.CONTENT_URI, null)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(JsonPrimitive(0), source.state.value["volume"])
    assertEquals(JsonPrimitive(true), source.state.value["muted"])
    assertTrue(
      shadowOf(context.contentResolver)
        .getContentObservers(Settings.System.CONTENT_URI)
        .isNotEmpty(),
    )
    source.close()
    assertTrue(
      shadowOf(context.contentResolver).getContentObservers(Settings.System.CONTENT_URI).isEmpty(),
    )
  }

  @Test
  fun `audio device callbacks and ringer broadcasts refresh and stop on close`() {
    val manager = context.getSystemService(AudioManager::class.java)
    val speaker =
      AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER).build()
    val bluetooth =
      AudioDeviceInfoBuilder.newBuilder().setType(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP).build()
    shadowOf(manager).setOutputDevices(listOf(speaker))
    val source = AndroidAudioStatusSource(context)
    assertEquals(JsonPrimitive("speaker"), source.state.value["route"])
    shadowOf(manager).addOutputDevice(bluetooth, true)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(JsonPrimitive("bluetooth"), source.state.value["route"])
    shadowOf(manager).removeOutputDevice(bluetooth, true)
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(JsonPrimitive("speaker"), source.state.value["route"])
    manager.ringerMode = AudioManager.RINGER_MODE_VIBRATE
    context.sendBroadcast(Intent(AudioManager.RINGER_MODE_CHANGED_ACTION))
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(JsonPrimitive("vibrate"), source.state.value["ringer"])
    val last = source.state.value
    source.close()
    shadowOf(manager).addOutputDevice(bluetooth, true)
    manager.ringerMode = AudioManager.RINGER_MODE_NORMAL
    context.sendBroadcast(Intent(AudioManager.RINGER_MODE_CHANGED_ACTION))
    shadowOf(Looper.getMainLooper()).idle()
    assertEquals(last, source.state.value)
  }

  @Test
  fun `runtime registry includes all status capabilities`() {
    val platform = prototypeRuntimePlatform(context)
    for (kind in DeviceStatusKind.entries) {
      assertTrue(
        platform.registry.capabilities.contains("prototype_platform_${kind.moduleName}_v1"),
      )
    }
    platform.registry.modules.forEach { it.close() }
  }
}
