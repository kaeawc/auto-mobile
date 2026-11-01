package dev.jasonpearson.automobile.ctrlproxy.storage

import android.content.Context
import android.util.Log
import androidx.core.net.toUri
import dev.jasonpearson.automobile.protocol.KeystoreResetState
import kotlinx.serialization.json.Json

private val resetJson = Json { ignoreUnknownKeys = true }

/** Resolves bridge absence structurally, never by interpreting exception text. */
internal fun resetKeystore(
  context: Context,
  packageName: String,
  scope: String?,
  alias: String?,
): KeystoreResetState {
  val authority = "$packageName.automobile.keystore"
  val failure =
    try {
      return if (context.packageManager.resolveContentProvider(authority, 0) == null) {
        KeystoreResetState(
          outcome = "unavailable",
          reason = "BRIDGE_NOT_INSTALLED",
          requestedScope = scope,
          requestedAlias = alias,
          bridgeAvailable = false,
        )
      } else {
        val result =
          context.contentResolver.call(
            "content://$authority".toUri(),
            "delete",
            null,
            android.os.Bundle().apply {
              scope?.let { putString("scope", it) }
              alias?.let { putString("alias", it) }
            },
          )
        val payload = result?.getString("result")
        if (payload == null) {
          Log.w("KeystoreReset", "Keystore provider returned no envelope")
          KeystoreResetState(
            outcome = "unavailable",
            reason = "BRIDGE_UNAVAILABLE",
            requestedScope = scope,
            requestedAlias = alias,
            bridgeAvailable = true,
          )
        } else {
          // Decode only identifiers and outcomes, discarding unexpected fields.
          resetJson.decodeFromString<KeystoreResetState>(payload)
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
    }
  Log.w("KeystoreReset", "Keystore reset unavailable", failure)
  return KeystoreResetState(
    outcome = "unavailable",
    reason = "BRIDGE_UNAVAILABLE",
    requestedScope = scope,
    requestedAlias = alias,
    bridgeAvailable = true,
  )
}
