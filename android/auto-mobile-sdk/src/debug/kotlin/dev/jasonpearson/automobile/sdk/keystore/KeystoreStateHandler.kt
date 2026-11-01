package dev.jasonpearson.automobile.sdk.keystore

import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.UserNotAuthenticatedException
import android.util.Log
import java.security.KeyStoreException
import java.security.ProviderException
import java.security.UnrecoverableKeyException
import org.json.JSONArray
import org.json.JSONObject

internal sealed class KeystoreResponse(val outcome: String, val reason: String? = null) {
  data object Disabled : KeystoreResponse("disabled", "DISABLED")

  data object Unavailable : KeystoreResponse("unavailable", "KEYSTORE_UNAVAILABLE")

  data object Unsupported : KeystoreResponse("unsupported", "DECLARED_UNSUPPORTED")

  data object Locked : KeystoreResponse("locked", "DEVICE_LOCKED")

  data object AuthenticationRequired :
    KeystoreResponse("authentication_required", "AUTHENTICATION_REQUIRED")

  data object ScopeNotDeclared : KeystoreResponse("scope_not_declared", "SCOPE_NOT_DECLARED")

  class Ok(val entries: List<AliasMetadata> = emptyList()) : KeystoreResponse("ok")
}

internal data class AliasMetadata(
  val alias: String,
  val present: Boolean,
  val category: EntryCategory,
)

/**
 * Caller authorization belongs to the provider; scoped deletion also enforces opt-in and the
 * injected mutation gate here. Backend/probe fakes keep this boundary deterministic.
 * deviceLocked=locked comes only from the injected device lock probe and does not block reads.
 * Metadata locked/authentication_required outcomes remain reserved: AndroidKeyStore swallows
 * metadata lookup failures, so reads cannot observe them. Deletion maps failures per alias.
 * present=false means not present or not observable, including an indistinguishable Keystore daemon
 * failure.
 */
internal class KeystoreStateHandler(
  private val backend: KeystoreBackend,
  private val lockProbe: DeviceLockProbe,
  private val mutationsAllowed: () -> Boolean = { false },
) {
  fun handle(method: String, scope: String? = null, alias: String? = null): JSONObject {
    if (method == "delete") return reset(scope, alias)
    if (!KeystoreTestState.isEnabled()) {
      return envelope(KeystoreResponse.Disabled, DeviceLockState.UNKNOWN)
    }
    val locked = probeLock()
    val response =
      when {
        // The delete call uses its own narrow envelope above.
        method != "discover" && method != "metadata" -> KeystoreResponse.Unsupported
        method == "discover" -> KeystoreResponse.Ok()
        else -> metadata(scope, alias, locked)
      }
    return envelope(response, locked)
  }

  /** Selectors and both authorization gates are checked before any backend operation. */
  private fun reset(scope: String?, alias: String?): JSONObject {
    val result =
      JSONObject().apply {
        put("schemaVersion", 1)
        put("capability", "storage.keystore")
        put("bridgeAvailable", true)
        scope?.let { put("requestedScope", it) }
        alias?.let { put("requestedAlias", it) }
        put("deletedCount", 0)
      }
    fun refuse(outcome: String, reason: String): JSONObject =
      result.put("outcome", outcome).put("reason", reason)
    if (scope.isNullOrBlank() && alias.isNullOrBlank()) {
      return refuse("invalid_selector", "EMPTY_SELECTOR")
    }
    if (!KeystoreTestState.isEnabled()) return refuse("disabled", "DISABLED")
    if (!mutationsAllowed()) return refuse("authorization_denied", "MUTATION_NOT_ALLOWED")
    val selected =
      selectedAliases(scope, alias) ?: return refuse("scope_not_declared", "SCOPE_NOT_DECLARED")
    val locked = probeLock()
    val outcomes = selected.map { name ->
      JSONObject().put("alias", name).put("outcome", deleteAlias(name, locked))
    }
    val deleted = outcomes.count { it.getString("outcome") == "deleted" }
    val status =
      when {
        deleted == outcomes.size -> "deleted"
        deleted > 0 -> "partial"
        else -> "failed"
      }
    return result
      .put("outcome", "ok")
      .put("status", status)
      .put("deletedCount", deleted)
      .put("aliases", JSONArray(outcomes))
  }

  private fun selectedAliases(scope: String?, alias: String?): List<String>? {
    val declared =
      if (scope != null) KeystoreTestState.aliasesForScope(scope)
      else
        KeystoreTestState.declaredScopes()
          .flatMap { KeystoreTestState.aliasesForScope(it).orEmpty() }
          .toSet()
    if (declared == null || (alias != null && alias !in declared)) return null
    return if (alias != null) listOf(alias) else declared.sorted()
  }

  private fun deleteAlias(alias: String, locked: DeviceLockState): String =
    try {
      if (!backend.containsAlias(alias)) "not_found"
      else {
        backend.deleteAlias(alias)
        "deleted"
      }
    } catch (error: Exception) {
      // Never include exception text or key material in the response or logs.
      Log.w("KeystoreTestState", "Keystore alias deletion failed")
      when (error) {
        is UserNotAuthenticatedException,
        is KeyPermanentlyInvalidatedException -> "authentication_required"
        is UnrecoverableKeyException,
        is KeyStoreException -> if (locked == DeviceLockState.LOCKED) "locked" else "failed"
        else -> "failed"
      }
    }

  private fun probeLock(): DeviceLockState =
    try {
      lockProbe.state()
    } catch (error: Exception) {
      Log.w("KeystoreTestState", "Device lock probe failed", error)
      DeviceLockState.UNKNOWN
    }

  private fun metadata(scope: String?, alias: String?, locked: DeviceLockState): KeystoreResponse {
    val aliases =
      scope?.let { KeystoreTestState.aliasesForScope(it) }
        ?: return KeystoreResponse.ScopeNotDeclared
    if (alias != null && alias !in aliases) return KeystoreResponse.ScopeNotDeclared
    return try {
      KeystoreResponse.Ok(
        (if (alias == null) aliases.sorted() else listOf(alias)).map { name ->
          val present = backend.containsAlias(name)
          AliasMetadata(
            name,
            present,
            if (present) backend.entryCategory(name) else EntryCategory.UNKNOWN,
          )
        },
      )
    } catch (error: Exception) {
      Log.w("KeystoreTestState", "Keystore metadata read failed", error)
      // Reserved mappings exercised by injected-backend contract tests, not the real SPI.
      when (error) {
        is UserNotAuthenticatedException,
        is KeyPermanentlyInvalidatedException -> KeystoreResponse.AuthenticationRequired
        // An unrecoverable entry while the device is verifiably locked can be reported as locked.
        // Generic KeyStore/Provider failures never infer lock state from text or the probe alone.
        is UnrecoverableKeyException ->
          if (locked == DeviceLockState.LOCKED) KeystoreResponse.Locked
          else KeystoreResponse.Unavailable
        is KeyStoreException,
        is ProviderException -> KeystoreResponse.Unavailable
        else -> KeystoreResponse.Unavailable
      }
    }
  }

  private fun envelope(response: KeystoreResponse, locked: DeviceLockState): JSONObject =
    JSONObject().apply {
      put("schemaVersion", 1)
      put("capability", "storage.keystore")
      put("outcome", response.outcome)
      response.reason?.let { put("reason", it) }
      put("bridgeAvailable", true)
      put("metadata", "supported")
      put("mutation", "declared_unsupported")
      put("deviceLocked", locked.name.lowercase())
      put(
        "scopes",
        JSONArray(
          if (KeystoreTestState.isEnabled()) KeystoreTestState.declaredScopes().sorted()
          else emptyList<String>(),
        ),
      )
      if (response is KeystoreResponse.Ok) {
        put(
          "entries",
          JSONArray(
            response.entries.map { entry ->
              JSONObject()
                .put("alias", entry.alias)
                .put("present", entry.present)
                .put("category", entry.category.name)
            },
          ),
        )
      }
    }
}
