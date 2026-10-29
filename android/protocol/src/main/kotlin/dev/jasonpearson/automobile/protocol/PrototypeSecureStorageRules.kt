package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.keyPath
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Secure storage rules (#14321) the contract cannot express, the twin of TypeScript's
 * `prototypeSecureStorage.ts`: `storage.secure` needs the `secureStorage` module, each key is a
 * declared string state key not also in `storage.keys`, a `secureAuth` entry names a secure key and
 * needs the `biometric` module, and no secure key may leave the device through an emit context or
 * through a `request` that does not opt in with `allowSecureInRequest: true`.
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

  /** The first way [action] sends a secure key off the device: an emit context, then a request. */
  fun actionError(action: JsonObject, path: String, root: JsonObject): PrototypeSpecError? =
    emitError(action, path, root) ?: requestError(action, path, root)

  private fun emitError(action: JsonObject, path: String, root: JsonObject): PrototypeSpecError? {
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
   * A `request` that sends a secure key without `allowSecureInRequest: true`: a `{state}` binding
   * in a header, query value or body (a whole body, a form entry or a multipart value), or a
   * `{key}` placeholder in the URL, a header or a query value. Members are checked in sorted order.
   */
  private fun requestError(
    action: JsonObject,
    path: String,
    root: JsonObject,
  ): PrototypeSpecError? {
    val secure = root.member("storage")?.strings("secure").orEmpty()
    if (action.text("type") != "request" || secure.isEmpty()) return null
    if ((action["allowSecureInRequest"] as? JsonPrimitive)?.booleanOrNull == true) return null
    val body = action.member("body")
    fun members(value: JsonObject?, at: String) =
      value
        .orEmpty()
        .entries
        .sortedBy { it.key }
        .map { (name, member) -> member to keyPath(at, name) }
    val candidates =
      listOf(action["url"] to "$path.url") +
        members(action.member("headers"), "$path.headers") +
        members(action.member("query"), "$path.query") +
        listOf(action["body"] to "$path.body") +
        members(body?.member("form"), "$path.body.form") +
        (body?.get("multipart") as? JsonArray).orEmpty().mapIndexed { index, part ->
          (part as? JsonObject)?.get("value") to "$path.body.multipart[$index].value"
        }
    for ((value, at) in candidates) {
      val key =
        (value as? JsonPrimitive)
          ?.takeIf { it.isString }
          ?.let { placeholderKey(it.content, secure) }
          ?: (value as? JsonObject)?.text("state")?.let { secureKeyFor(it, secure) }
      if (key != null)
        return fail(
          at,
          "Secure storage key $key cannot be sent in a request without allowSecureInRequest",
        )
    }
    return null
  }

  /**
   * The secure key a `{key}` text placeholder names. Every `{...}` group that closes is checked, at
   * every depth: request text resolves an inner `{token}` even when an outer brace never closes
   * (`{{token}`), and a group may hold repeat placeholders, as in `{tok{row.id}}`, which repeat
   * binding turns into `{token}`, so a group is matched as a template whose inner groups may stand
   * for any text.
   */
  private fun placeholderKey(text: String, secure: List<String>): String? {
    val open = ArrayDeque<Int>()
    for ((index, char) in text.withIndex()) {
      if (char == '{') open.addLast(index + 1)
      else if (char == '}' && open.isNotEmpty())
        secureKeyFor(text.substring(open.removeLast(), index), secure)?.let {
          return it
        }
    }
    return null
  }

  /**
   * The first secure `state:` key a context state reference can read. A repeat template such as
   * `token_{item.id}` is expanded per row on the device, so each `{...}` placeholder may stand for
   * any text there.
   */
  private fun secureKeyFor(stateKey: String, secure: List<String>): String? {
    val literals = stateKey.split(Regex("\\{[^}]*\\}"))
    return secure.firstOrNull {
      it.startsWith("state:") && templateMatches(literals, it.removePrefix("state:"))
    }
  }

  /**
   * Whether [key] fits the literal parts of a template whose gaps match any text. Linear: the first
   * and last literals anchor the ends and each middle literal is found left to right.
   */
  private fun templateMatches(literals: List<String>, key: String): Boolean {
    val first = literals.first()
    if (literals.size == 1) return key == first
    val last = literals.last()
    val end = key.length - last.length
    if (end < first.length || !key.startsWith(first) || !key.endsWith(last)) return false
    var at = first.length
    for (part in literals.subList(1, literals.size - 1)) {
      val found = key.indexOf(part, at)
      if (found < 0 || found + part.length > end) return false
      at = found + part.length
    }
    return true
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
