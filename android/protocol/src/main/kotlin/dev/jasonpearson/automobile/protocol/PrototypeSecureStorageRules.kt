package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Secure storage rules (#14321) the contract cannot express, the twin of TypeScript's
 * `prototypeSecureStorage.ts`: `storage.secure` needs the `secureStorage` module, each key is a
 * declared string state key not also in `storage.keys`, a `secureAuth` entry names a secure key and
 * needs the `biometric` module, and no secure key may leave the device through an emit context.
 */
internal object PrototypeSecureStorageRules {
  fun blockError(root: JsonObject): PrototypeSpecError? {
    val storage = root.member("storage") ?: return null
    val platform = root.member("requires")?.strings("platform") ?: emptyList()
    val secure = storage["secure"] as? JsonArray
    if (secure != null)
      listError(secure, root, storage.strings("keys"), platform)?.let {
        return it
      }
    // secureAuth is checked even without storage.secure: it may only name secure keys.
    val names = secure.orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
    for (name in storage.member("secureAuth")?.keys.orEmpty()) {
      val path = keyPath("storage.secureAuth", name)
      if (name !in names) return fail(path, "secureAuth names a key that is not in storage.secure")
      if ("biometric" !in platform)
        return fail(path, "Biometric secure keys require biometric in requires.platform")
    }
    return null
  }

  private fun listError(
    secure: JsonArray,
    root: JsonObject,
    keys: List<String>,
    platform: List<String>,
  ): PrototypeSpecError? {
    if ("secureStorage" !in platform)
      return fail("storage.secure", "storage.secure requires secureStorage in requires.platform")
    secure.forEachIndexed { index, entry ->
      keyError((entry as? JsonPrimitive)?.takeIf { it.isString }?.content, root, keys)?.let {
        return fail("storage.secure[$index]", it)
      }
    }
    return null
  }

  fun emitError(action: JsonObject, path: String, root: JsonObject): PrototypeSpecError? {
    if (action.text("type") != "emit") return null
    val context = action.member("context") ?: return null
    val secure = root.member("storage")?.strings("secure") ?: return null
    for ((name, binding) in context) {
      val key = (binding as? JsonObject)?.text("state") ?: continue
      val leaked = secureKeyFor(key, secure) ?: continue
      return fail(
        keyPath("$path.context", name),
        "Secure storage key $leaked cannot be sent in an emit context",
      )
    }
    return null
  }

  /**
   * The first secure `state:` key a context state reference can read. A repeat template such as
   * `token_{item.id}` is expanded per row on the device, so each `{...}` placeholder may stand for
   * any text there.
   */
  private fun secureKeyFor(stateKey: String, secure: List<String>): String? {
    val pattern =
      Regex(stateKey.split(Regex("\\{[^}]*\\}")).joinToString(".*") { Regex.escape(it) })
    return secure.firstOrNull {
      it.startsWith("state:") && pattern.matches(it.removePrefix("state:"))
    }
  }

  private fun keyError(entry: String?, root: JsonObject, keys: List<String>): String? {
    val invalid = "Secure storage keys are state:<key>"
    if (entry == null || !entry.startsWith("state:")) return invalid
    val key = entry.removePrefix("state:")
    if (!PrototypeSpecContract.stateKeyPattern.matches(key)) return invalid
    val state = root.member("state") ?: JsonObject(emptyMap())
    val value = state[key] ?: return "Secure storage key $entry is not declared in state"
    if ((value as? JsonPrimitive)?.isString != true)
      return "Secure storage keys must hold a string state value"
    return if (entry in keys) "Secure storage key $entry is also listed in storage.keys" else null
  }
}
