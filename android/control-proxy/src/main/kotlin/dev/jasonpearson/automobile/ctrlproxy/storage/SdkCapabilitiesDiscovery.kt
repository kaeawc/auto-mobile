package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.Context
import android.net.Uri
import android.util.Log
import dev.jasonpearson.automobile.protocol.SdkCapabilitiesState
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

private val sdkCapabilitiesJson = Json { ignoreUnknownKeys = true }

/**
 * Reads the SDK capability and capture-policy snapshot from the app's debug bridge provider.
 * Absence is resolved structurally (provider lookup), never by interpreting exception text.
 */
internal fun discoverSdkCapabilities(context: Context, packageName: String): SdkCapabilitiesState {
  val authority = "$packageName.automobile.capabilities"
  return try {
    if (context.packageManager.resolveContentProvider(authority, 0) == null) {
      return unavailableSdkCapabilities("BRIDGE_NOT_INSTALLED")
    }
    val payload =
      context.contentResolver
        .call(Uri.parse("content://$authority"), "snapshot", null, null)
        ?.getString("result")
    if (payload == null) {
      Log.w("SdkCapabilities", "Capability provider returned no snapshot")
      return unavailableSdkCapabilities("BRIDGE_UNAVAILABLE")
    }
    val snapshot = sdkCapabilitiesJson.parseToJsonElement(payload)
    if (snapshot !is JsonObject) {
      Log.w("SdkCapabilities", "Capability snapshot was not a JSON object")
      return unavailableSdkCapabilities("MALFORMED_RESPONSE")
    }
    SdkCapabilitiesState(outcome = "ok", snapshot = snapshot)
  } catch (error: SerializationException) {
    Log.w("SdkCapabilities", "Capability snapshot was malformed", error)
    unavailableSdkCapabilities("MALFORMED_RESPONSE")
  } catch (error: Exception) {
    Log.w("SdkCapabilities", "Capability discovery unavailable", error)
    unavailableSdkCapabilities("BRIDGE_UNAVAILABLE")
  }
}

private fun unavailableSdkCapabilities(reason: String) =
  SdkCapabilitiesState(outcome = "unavailable", reason = reason)
