package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.Context
import android.net.Uri
import android.util.Log
import dev.jasonpearson.automobile.protocol.KeystoreDiscoveryState
import kotlinx.serialization.json.Json

private val discoveryJson = Json { ignoreUnknownKeys = true }

/** Resolves bridge absence structurally, never by interpreting exception text. */
internal fun discoverKeystore(context: Context, packageName: String): KeystoreDiscoveryState {
  val authority = "$packageName.automobile.keystore"
  return try {
    if (context.packageManager.resolveContentProvider(authority, 0) == null) {
      KeystoreDiscoveryState(
        outcome = "unavailable",
        reason = "BRIDGE_NOT_INSTALLED",
        bridgeAvailable = false,
      )
    } else {
      val result =
        context.contentResolver.call(Uri.parse("content://$authority"), "discover", null, null)
      val payload = result?.getString("result")
      if (payload == null) {
        Log.w("KeystoreDiscovery", "Keystore provider returned no envelope")
        KeystoreDiscoveryState(
          outcome = "unavailable",
          reason = "BRIDGE_UNAVAILABLE",
          bridgeAvailable = true,
        )
      } else {
        // Ignore SDK metadata entries here: discovery forwards only the narrow capability schema.
        discoveryJson.decodeFromString<KeystoreDiscoveryState>(payload)
      }
    }
  } catch (error: Exception) {
    Log.w("KeystoreDiscovery", "Keystore discovery unavailable", error)
    KeystoreDiscoveryState(
      outcome = "unavailable",
      reason = "BRIDGE_UNAVAILABLE",
      bridgeAvailable = true,
    )
  }
}
