package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.database.ContentObserver
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings

internal class AndroidAudioStatusSource(context: Context) :
  PrototypeDeviceStatusSource by AndroidDeviceStatusSource(AndroidAudioStatusGateway(context))

private class AndroidAudioStatusGateway(private val context: Context) : AndroidStatusGateway {
  private val manager by lazy { context.getSystemService(AudioManager::class.java) }

  override fun read() =
    PrototypeDeviceStatus.audio(
      AudioStatusReading(
        manager.getStreamVolume(AudioManager.STREAM_MUSIC),
        manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC),
        manager.isStreamMute(AudioManager.STREAM_MUSIC),
        manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { route(it.type) }.toSet(),
        manager.ringerMode,
      ),
    )

  override fun observe(changed: () -> Unit, retain: (() -> Unit) -> Unit) {
    val handler = Handler(Looper.getMainLooper())
    val observer =
      object : ContentObserver(handler) {
        override fun onChange(selfChange: Boolean) = changed()
      }
    context.contentResolver.registerContentObserver(Settings.System.CONTENT_URI, true, observer)
    retain { context.contentResolver.unregisterContentObserver(observer) }
    val callback =
      object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(addedDevices: Array<AudioDeviceInfo>) = changed()

        override fun onAudioDevicesRemoved(removedDevices: Array<AudioDeviceInfo>) = changed()
      }
    manager.registerAudioDeviceCallback(callback, handler)
    retain { manager.unregisterAudioDeviceCallback(callback) }
    observeStatusBroadcast(context, AudioManager.RINGER_MODE_CHANGED_ACTION, changed, retain)
  }

  private fun route(type: Int): String =
    when (type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_LINE_ANALOG -> "wired"
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_BLE_BROADCAST -> "bluetooth"
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_USB_ACCESSORY,
      AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
      else -> "other"
    }
}
