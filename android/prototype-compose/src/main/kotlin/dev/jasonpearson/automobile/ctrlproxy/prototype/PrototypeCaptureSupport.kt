package dev.jasonpearson.automobile.ctrlproxy.prototype

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.os.Build
import android.util.Log
import androidx.activity.ComponentActivity
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule

/** Whether this host can capture with [permission]: declared in its manifest, and hardware. */
fun interface PrototypeCaptureSupport {
  fun available(permission: PrototypeRuntimePermission): Boolean
}

/**
 * The camera and microphone advertisement rule (#18797): a capture module registers, and so its
 * capability is advertised, only when the host declares the permission and the device has a camera
 * id (camera) or an audio input (microphone).
 */
object PrototypeCaptureModules {
  private val needs =
    mapOf(
      "camera" to PrototypeRuntimePermission.CAMERA,
      "audioRecorder" to PrototypeRuntimePermission.MICROPHONE,
    )

  fun retain(
    modules: List<PrototypePlatformModule>,
    support: PrototypeCaptureSupport,
  ): List<PrototypePlatformModule> = modules.filter { module ->
    val permission = needs[module.name]
    val keep = permission == null || support.available(permission)
    if (!keep) module.close()
    keep
  }
}

class AndroidPrototypeCaptureSupport(private val context: Context) : PrototypeCaptureSupport {
  override fun available(permission: PrototypeRuntimePermission): Boolean =
    declaresPermission(context, permission.manifest) && captureHardwarePresent(context, permission)
}

/**
 * Notification, camera and microphone sources for one Activity. They share one prompt slot, since
 * an Activity shows one permission dialog at a time.
 */
fun androidPrototypePermissionSources(
  activity: ComponentActivity,
): Map<PrototypeRuntimePermission, PrototypePermissionsSource> {
  val slot = PrototypePromptSlot()
  return PrototypeRuntimePermission.entries.associateWith {
    AndroidPermissionsSource(activity, it, slot)
  }
}

/** One in-flight permission dialog per Activity, across every source and runtime session. */
internal class PrototypePromptSlot {
  var requesting = false
}

internal fun declaresPermission(context: Context, name: String): Boolean {
  val manager = context.packageManager
  val info =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      manager.getPackageInfo(
        context.packageName,
        PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()),
      )
    } else {
      @Suppress("DEPRECATION")
      manager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
    }
  return info.requestedPermissions.orEmpty().contains(name)
}

internal fun captureHardwarePresent(
  context: Context,
  permission: PrototypeRuntimePermission,
): Boolean =
  when (permission) {
    PrototypeRuntimePermission.NOTIFICATIONS -> true
    PrototypeRuntimePermission.CAMERA -> cameraPresent(context)
    PrototypeRuntimePermission.MICROPHONE ->
      context
        .getSystemService(AudioManager::class.java)
        ?.getDevices(AudioManager.GET_DEVICES_INPUTS)
        .orEmpty()
        .isNotEmpty()
  }

private fun cameraPresent(context: Context): Boolean =
  try {
    context.getSystemService(CameraManager::class.java)?.cameraIdList.orEmpty().isNotEmpty()
  } catch (error: CameraAccessException) {
    Log.w("PrototypeCapture", "Camera id list unavailable; reporting no camera", error)
    false
  }
