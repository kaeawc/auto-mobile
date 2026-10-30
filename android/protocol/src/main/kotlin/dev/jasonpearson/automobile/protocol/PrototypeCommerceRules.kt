package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Root `commerce` catalog rules (#14314) the contract cannot express, the twin of TypeScript's
 * `prototypeCommerce.ts`: the block needs `commerce` in `requires.platform`, product ids are
 * unique, only a subscription has a `period` or `trialPeriod`, a `commerce.*` call needs the
 * catalog, and a literal `commerce.purchase` product id names a catalog product.
 */
internal object PrototypeCommerceRules {
  fun blockError(root: JsonObject): PrototypeSpecError? {
    val commerce = root.member("commerce") ?: return null
    if ("commerce" !in (root.member("requires")?.strings("platform") ?: emptyList()))
      return fail("commerce", "The commerce block requires commerce in requires.platform")
    val seen = HashSet<JsonElement?>()
    (commerce["products"] as? JsonArray).orEmpty().forEachIndexed { index, entry ->
      val product = entry as? JsonObject ?: JsonObject(emptyMap())
      val at = "commerce.products[$index]"
      if (!seen.add(product["id"])) return fail("$at.id", "Duplicate product id")
      val period = listOf("period", "trialPeriod").firstOrNull { it in product }
      if (period != null && product.text("kind") != "subscription")
        return fail("$at.$period", "Only a subscription has a period")
    }
    return null
  }

  fun callError(action: JsonObject, path: String, root: JsonObject): PrototypeSpecError? {
    val call = action.text("call")?.takeIf { it.startsWith("commerce.") } ?: return null
    val commerce =
      root.member("commerce") ?: return fail("$path.call", "$call requires a root commerce block")
    val productId = action.member("args")?.member("productId")?.text("value") ?: return null
    val known =
      (commerce["products"] as? JsonArray).orEmpty().any {
        (it as? JsonObject)?.text("id") == productId
      }
    return if (known) null else fail("$path.args.productId.value", "Unknown product")
  }
}
