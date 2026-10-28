package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Root `auth` block rules (#14303) the contract cannot express, the twin of TypeScript's
 * `prototypeAuth.ts`: the block needs `auth` in `requires.platform`, account ids are unique, and an
 * `auth.*` call needs the block's accounts.
 */
internal object PrototypeAuthRules {
  fun blockError(root: JsonObject): PrototypeSpecError? {
    val auth = root.member("auth") ?: return null
    if ("auth" !in (root.member("requires")?.strings("platform") ?: emptyList()))
      return fail("auth", "The auth block requires auth in requires.platform")
    val seen = HashSet<JsonElement?>()
    (auth["accounts"] as? JsonArray).orEmpty().forEachIndexed { index, account ->
      if (!seen.add((account as? JsonObject)?.get("id")))
        return fail("auth.accounts[$index].id", "Duplicate account id")
    }
    return null
  }

  fun callError(action: JsonObject, path: String, root: JsonObject): PrototypeSpecError? {
    val call = action.text("call") ?: return null
    return if (call.startsWith("auth.") && root.member("auth") == null)
      fail("$path.call", "$call requires a root auth block")
    else null
  }
}
