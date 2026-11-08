package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive

/**
 * The spec's root-level `storage` block (#12522, `prototype_storage_v1`): the state keys
 * (`state:<key>`) and `/data` pointers (`data:<pointer relative to /data>`) the device keeps under
 * the spec id and restores on the next show of that id. The contract validates the shape; the host
 * validates the cross-references.
 */
@Serializable
data class PrototypeStorageBlock(
  val version: Int,
  val keys: List<String>,
  /** `state:` keys for the Keystore, never plaintext storage (#14321). */
  val secure: List<String>? = null,
  /** Secure keys that unlock only after `biometric.authenticate` (#14321). */
  val secureAuth: Map<String, String>? = null,
)

/** One entry of a [PrototypeStorageBlock.keys] list, parsed. */
sealed interface PrototypeStorageKey {
  data class State(val key: String) : PrototypeStorageKey

  data class Data(val pointer: String) : PrototypeStorageKey

  companion object {
    private const val STATE_PREFIX = "state:"
    private const val DATA_PREFIX = "data:"

    /** Null when [storageKey] is neither `state:<key>` nor `data:<pointer under /data>`. */
    fun parse(storageKey: String): PrototypeStorageKey? =
      when {
        storageKey.startsWith(STATE_PREFIX) ->
          storageKey
            .removePrefix(STATE_PREFIX)
            .takeIf(PrototypeSpecValidator.stateKeyPattern::matches)
            ?.let(::State)
        storageKey.startsWith(DATA_PREFIX) -> {
          // `/data` + pointer is the path form every data action uses, so share its guard.
          val pointer = storageKey.removePrefix(DATA_PREFIX)
          pointer.takeIf { PrototypeDataWriter.pathPointer("/data$it") == it }?.let(::Data)
        }
        else -> null
      }
  }
}

/**
 * The values stored for one id, with the `storage.version` they were stored under. [secure] holds
 * the secure store's values by `state:<key>` (#14321); a biometric-bound entry only marks that the
 * key holds a value, its content is not read. [invalidated] lists secure keys whose hardware key
 * was revoked.
 */
data class PrototypeStoredValues(
  val version: Int,
  val values: Map<String, JsonElement>,
  val secure: Map<String, JsonElement> = emptyMap(),
  val invalidated: List<String> = emptyList(),
)

enum class PrototypeStorageDropReason {
  VERSION,
  UNLISTED,
  MISMATCH,
  /** A secure key whose hardware key was revoked: its value is gone and the spec's value stands. */
  INVALIDATED,
}

data class PrototypeStorageDrop(val key: String, val reason: PrototypeStorageDropReason)

/**
 * [spec] is the shown spec with the stored values applied; [applied] are the storage keys whose
 * stored value replaced the spec's, [dropped] the stored entries to delete, [locked] the
 * biometric-bound secure keys holding a value that waits for `biometric.authenticate`.
 */
data class PrototypeStorageRestore(
  val spec: PrototypeSpec,
  val applied: List<String>,
  val dropped: List<PrototypeStorageDrop>,
  val locked: List<String> = emptyList(),
)

/** The device's per-prototype report: bytes per stored key and the keys it declined to store. */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
data class PrototypeStorageReport(
  val version: Int,
  val keys: List<PrototypeStorageKeyBytes>,
  val totalBytes: Int,
  @EncodeDefault(EncodeDefault.Mode.NEVER) val skippedKeys: List<String>? = null,
)

@Serializable data class PrototypeStorageKeyBytes(val key: String, val bytes: Int)

/**
 * The precedence rules for a prototype's stored values on a show (#12522), the Kotlin twin of
 * `restorePrototypeStorage` in `src/features/prototype/prototypeStorageRestore.ts`: stored values
 * replace the spec's for the listed keys unless `storage.version` differs; unlisted keys are
 * dropped (a spec without `storage` drops all); a value that no longer fits (a state type mismatch,
 * an undeclared state key, a data JSON-kind mismatch, a write the data writer refuses) is dropped
 * and the spec's value stands. Restoring is pure: it bumps no revision and emits nothing.
 *
 * Secure keys (#14321) follow the same version and listing rules, read from
 * [PrototypeStoredValues.secure]: a value restores only into a key `storage.secure` lists, as a
 * string of at most `MAX_PROTOTYPE_SECURE_VALUE_BYTES` UTF-8 bytes into a declared string state
 * key, else it is a mismatch; a plaintext copy of a secure key is unlisted; a biometric-bound key
 * holding a value is not read, its state holds `""` and it is listed in `locked`; an invalidated
 * key is dropped with reason `INVALIDATED` and the spec's value stands.
 */
object PrototypeStorageRestorer {
  /** The largest secure value, in UTF-8 bytes (contract `limits`). */
  val maxSecureValueBytes: Int =
    PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_SECURE_VALUE_BYTES").jsonPrimitive.int

  fun restore(spec: PrototypeSpec, stored: PrototypeStoredValues?): PrototypeStorageRestore {
    if (stored == null) return PrototypeStorageRestore(spec, emptyList(), emptyList())
    val block = spec.storage
    val listed = block?.keys.orEmpty().toSet()
    val versionChanged = block != null && block.version != stored.version
    val secure = restoreSecure(spec, stored, versionChanged)
    var restored = secure.spec
    val applied = secure.applied.toMutableList()
    val dropped = secure.dropped.toMutableList()
    for ((key, value) in stored.values) {
      val next =
        when {
          key !in listed -> {
            dropped += PrototypeStorageDrop(key, PrototypeStorageDropReason.UNLISTED)
            continue
          }
          versionChanged -> {
            dropped += PrototypeStorageDrop(key, PrototypeStorageDropReason.VERSION)
            continue
          }
          else -> restoreOne(restored, spec, key, value)
        }
      if (next == null) dropped += PrototypeStorageDrop(key, PrototypeStorageDropReason.MISMATCH)
      else {
        restored = next
        applied += key
      }
    }
    return PrototypeStorageRestore(restored, applied, dropped, secure.locked)
  }

  /** Applies the secure store's values: dropped, locked behind biometrics, or put in state. */
  private fun restoreSecure(
    spec: PrototypeSpec,
    stored: PrototypeStoredValues,
    versionChanged: Boolean,
  ): PrototypeStorageRestore {
    val invalidated = stored.invalidated.toSet()
    val dropped =
      invalidated
        .map { PrototypeStorageDrop(it, PrototypeStorageDropReason.INVALIDATED) }
        .toMutableList()
    val applied = mutableListOf<String>()
    val locked = mutableListOf<String>()
    var state = spec.state.orEmpty()
    for ((key, value) in stored.secure) {
      if (key in invalidated) continue
      val stateKey = (PrototypeStorageKey.parse(key) as? PrototypeStorageKey.State)?.key
      val reason = secureDropReason(spec, key, value, versionChanged)
      when {
        reason != null || stateKey == null ->
          dropped += PrototypeStorageDrop(key, reason ?: PrototypeStorageDropReason.MISMATCH)
        isBiometric(spec, key) -> {
          state = state + (stateKey to PrototypeScalar.Text(""))
          locked += key
        }
        else -> {
          state = state + (stateKey to PrototypeScalar.Text((value as JsonPrimitive).content))
          applied += key
        }
      }
    }
    val restored = if (applied.isEmpty() && locked.isEmpty()) spec else spec.copy(state = state)
    return PrototypeStorageRestore(restored, applied, dropped, locked)
  }

  private fun isBiometric(spec: PrototypeSpec, key: String): Boolean =
    spec.storage?.secureAuth?.get(key) == "biometric"

  /** Why a secure value cannot restore, or null when it fits (or waits for an unlock). */
  private fun secureDropReason(
    spec: PrototypeSpec,
    key: String,
    value: JsonElement,
    versionChanged: Boolean,
  ): PrototypeStorageDropReason? {
    val stateKey = (PrototypeStorageKey.parse(key) as? PrototypeStorageKey.State)?.key
    return when {
      key !in spec.storage?.secure.orEmpty() -> PrototypeStorageDropReason.UNLISTED
      versionChanged -> PrototypeStorageDropReason.VERSION
      stateKey == null || spec.state?.get(stateKey) !is PrototypeScalar.Text ->
        PrototypeStorageDropReason.MISMATCH
      // A biometric-bound value is sealed until authentication; only its presence is known here.
      isBiometric(spec, key) || fitsSecure(value) -> null
      else -> PrototypeStorageDropReason.MISMATCH
    }
  }

  private fun fitsSecure(value: JsonElement): Boolean =
    value is JsonPrimitive &&
      value.isString &&
      value.content.toByteArray(Charsets.UTF_8).size <= maxSecureValueBytes

  /**
   * The values [spec] currently holds for its listed keys, by storage key; absent ones are left
   * out.
   */
  fun currentValues(spec: PrototypeSpec): Map<String, JsonElement> = buildMap {
    for (storageKey in spec.storage?.keys.orEmpty()) {
      val value =
        when (val key = PrototypeStorageKey.parse(storageKey)) {
          is PrototypeStorageKey.State -> spec.state?.get(key.key)?.let(EmitContextResolver::scalar)
          is PrototypeStorageKey.Data -> PrototypeDataPointer.resolve(spec.data, key.pointer)
          null -> null
        }
      if (value != null) put(storageKey, value)
    }
  }

  /**
   * [currentValues] plus each listed `stack:<id>` key's current path from [stacks] (#14188), as
   * [PrototypeRouteRuntime.storedValue] stores it.
   */
  fun currentValues(
    spec: PrototypeSpec,
    stacks: Map<String, PrototypeStackSnapshot>,
  ): Map<String, JsonElement> =
    currentValues(spec) +
      spec.storage
        ?.keys
        .orEmpty()
        .filter { it.startsWith(PrototypeRouteRuntime.STACK_STORAGE_PREFIX) }
        .mapNotNull { key ->
          stacks[key.removePrefix(PrototypeRouteRuntime.STACK_STORAGE_PREFIX)]?.let {
            key to PrototypeRouteRuntime.storedValue(it)
          }
        }

  /** UTF-8 bytes of the storage key plus the compact JSON of its value. */
  fun entryBytes(storageKey: String, value: JsonElement): Int =
    storageKey.toByteArray(Charsets.UTF_8).size + value.toString().toByteArray(Charsets.UTF_8).size

  /** The spec with [value] applied at [storageKey], or null when the value does not fit. */
  private fun restoreOne(
    restored: PrototypeSpec,
    authored: PrototypeSpec,
    storageKey: String,
    value: JsonElement,
  ): PrototypeSpec? =
    // A stored stack path lives in the runtime, not the spec: only its shape is checked here, and
    // the runtime starts the stack at `start` when its screens or params no longer fit (#14188).
    if (storageKey.startsWith(PrototypeRouteRuntime.STACK_STORAGE_PREFIX))
      restored.takeIf {
        value is JsonArray &&
          value.isNotEmpty() &&
          value.all { entry ->
            ((entry as? JsonObject)?.get("screen") as? JsonPrimitive)?.isString == true
          }
      }
    else
      when (val key = PrototypeStorageKey.parse(storageKey)) {
        is PrototypeStorageKey.State -> {
          val scalar = fittingScalar(authored.state?.get(key.key), value)
          scalar?.let { restored.copy(state = restored.state.orEmpty() + (key.key to it)) }
        }
        is PrototypeStorageKey.Data -> {
          // Compare against the spec's own value, not the restore so far: an earlier stored key
          // must
          // not change what "the spec's value" is for a later one.
          val own = PrototypeDataPointer.resolve(authored.data, key.pointer)
          val fits = value !is JsonPrimitive || value.isString || value.content != "null"
          if (!fits || (own != null && kind(own) != kind(value))) null
          else
            (PrototypeDataWriter.apply(
                restored.data,
                PrototypeDataWrite.Set("/data${key.pointer}", value),
              ) as? PrototypeDataWriteResult.Success)
              ?.let { restored.copy(data = it.data) }
        }
        null -> null
      }

  /** The stored value as the declared scalar's own type, or null when the type differs. */
  private fun fittingScalar(declared: PrototypeScalar?, stored: JsonElement): PrototypeScalar? {
    val primitive = stored as? JsonPrimitive ?: return null
    return when (declared) {
      is PrototypeScalar.Binding -> null
      is PrototypeScalar.Text ->
        if (primitive.isString) PrototypeScalar.Text(primitive.content) else null
      is PrototypeScalar.Numeric ->
        primitive
          .takeUnless { it.isString }
          ?.doubleOrNull
          ?.takeIf(Double::isFinite)
          ?.let {
            PrototypeScalar.Numeric(it)
          }
      is PrototypeScalar.BooleanValue ->
        primitive.takeUnless { it.isString }?.booleanOrNull?.let(PrototypeScalar::BooleanValue)
      null -> null
    }
  }

  private fun kind(value: JsonElement): String =
    when (value) {
      is JsonObject -> "object"
      is JsonArray -> "array"
      // JsonNull is a JsonPrimitive; it is its own kind, never a number.
      is JsonNull -> "null"
      is JsonPrimitive ->
        when {
          value.isString -> "string"
          value.booleanOrNull != null -> "boolean"
          else -> "number"
        }
    }
}
