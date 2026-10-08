package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Process
import android.util.Log
import dev.jasonpearson.automobile.protocol.SdkCapabilitiesState
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

private val sdkCapabilitiesJson = Json { ignoreUnknownKeys = true }

// Android encodes the user ID in the upper portion of every process UID; UserHandle's helpers for
// it are hidden APIs.
private const val ANDROID_USER_ID_RANGE = 100_000

/**
 * Either grants access to another user's providers; neither is held by a sideloaded APK by default.
 */
private val CROSS_USER_PERMISSIONS =
  listOf(
    "android.permission.INTERACT_ACROSS_USERS",
    "android.permission.INTERACT_ACROSS_USERS_FULL",
  )

/**
 * Reads the SDK capability and capture-policy snapshot from the app's debug bridge provider.
 * Absence is resolved structurally (provider lookup), never by interpreting exception text.
 *
 * [userId] targets the app instance in another Android user (work or secondary profile). A null
 * [userId], or one equal to [serviceUserId], reads the service's own user. Another user needs
 * INTERACT_ACROSS_USERS; without it the result is `CROSS_USER_UNSUPPORTED` rather than a read of
 * the wrong user's instance.
 */
internal fun discoverSdkCapabilities(
  context: Context,
  packageName: String,
  userId: Int? = null,
  serviceUserId: Int = Process.myUid() / ANDROID_USER_ID_RANGE,
): SdkCapabilitiesState {
  val authority = "$packageName.automobile.capabilities"
  return try {
    if (userId == null || userId == serviceUserId) {
      readOwnUser(context, authority)
    } else {
      readOtherUser(context, authority, userId)
    }
  } catch (error: SerializationException) {
    Log.w("SdkCapabilities", "Capability snapshot was malformed", error)
    unavailableSdkCapabilities("MALFORMED_RESPONSE")
  } catch (error: Exception) {
    Log.w("SdkCapabilities", "Capability discovery unavailable", error)
    unavailableSdkCapabilities("BRIDGE_UNAVAILABLE")
  }
}

private fun readOwnUser(context: Context, authority: String): SdkCapabilitiesState {
  if (context.packageManager.resolveContentProvider(authority, 0) == null) {
    return unavailableSdkCapabilities("BRIDGE_NOT_INSTALLED")
  }
  return parseSnapshot(
    context.contentResolver.call(Uri.parse("content://$authority"), "snapshot", null, null),
  )
}

private fun readOtherUser(context: Context, authority: String, userId: Int): SdkCapabilitiesState {
  if (
    CROSS_USER_PERMISSIONS.none {
      context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
    }
  ) {
    Log.w("SdkCapabilities", "Reading user $userId needs INTERACT_ACROSS_USERS, which is not held")
    return unavailableSdkCapabilities("CROSS_USER_UNSUPPORTED")
  }
  // `content://<userId>@<authority>` is how ContentResolver addresses another user's provider.
  // PackageManager has no public per-user provider lookup, so a null client is the structural
  // signal that the bridge is absent in that user.
  val client =
    context.contentResolver.acquireUnstableContentProviderClient(
      Uri.parse("content://$userId@$authority"),
    ) ?: return unavailableSdkCapabilities("BRIDGE_NOT_INSTALLED")
  return client.use { parseSnapshot(it.call("snapshot", null, null)) }
}

private fun parseSnapshot(result: Bundle?): SdkCapabilitiesState {
  val payload = result?.getString("result")
  if (payload == null) {
    Log.w("SdkCapabilities", "Capability provider returned no snapshot")
    return unavailableSdkCapabilities("BRIDGE_UNAVAILABLE")
  }
  val snapshot = sdkCapabilitiesJson.parseToJsonElement(payload)
  if (snapshot !is JsonObject) {
    Log.w("SdkCapabilities", "Capability snapshot was not a JSON object")
    return unavailableSdkCapabilities("MALFORMED_RESPONSE")
  }
  return SdkCapabilitiesState(outcome = "ok", snapshot = snapshot)
}

private fun unavailableSdkCapabilities(reason: String) =
  SdkCapabilitiesState(outcome = "unavailable", reason = reason)
