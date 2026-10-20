package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.Context
import android.util.Log
import androidx.core.net.toUri
import dev.jasonpearson.automobile.protocol.KeystoreDiscoveryState
import kotlinx.serialization.json.Json

private val discoveryJson = Json { ignoreUnknownKeys = true }

/** Resolves bridge absence structurally, never by interpreting exception text. */
internal fun discoverKeystore(context: Context, packageName: String): KeystoreDiscoveryState {
  val authority = "$packageName.automobile.keystore"
  val failure =
    try {
      return if (context.packageManager.resolveContentProvider(authority, 0) == null) {
        KeystoreDiscoveryState(
          outcome = "unavailable",
          reason = "BRIDGE_NOT_INSTALLED",
          bridgeAvailable = false,
        )
      } else {
        val result =
          context.contentResolver.call("content://$authority".toUri(), "discover", null, null)
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
    } catch (error: IllegalArgumentException) {
      error
    } catch (error: IllegalStateException) {
      if (error is kotlinx.coroutines.CancellationException) throw error
      error
    } catch (error: SecurityException) {
      error
    } catch (error: UnsupportedOperationException) {
      error
    } catch (error: android.os.BadParcelableException) {
      error
    } catch (error: NullPointerException) {
      error
    }
  Log.w("KeystoreDiscovery", "Keystore discovery unavailable", failure)
  return KeystoreDiscoveryState(
    outcome = "unavailable",
    reason = "BRIDGE_UNAVAILABLE",
    bridgeAvailable = true,
  )
}
