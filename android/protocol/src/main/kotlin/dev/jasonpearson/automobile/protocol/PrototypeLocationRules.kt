package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.strings
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * Root `location` subscription block rules (#14324) the contract cannot express, the twin of
 * TypeScript's `prototypeLocationBlock.ts`: the block needs `location` in `requires.platform` and
 * the `location` permission in `requires.permissions`.
 */
internal object PrototypeLocationRules {
  fun blockError(root: JsonObject): PrototypeSpecError? {
    root.member("location") ?: return null
    val requires = root.member("requires")
    if ("location" !in (requires?.strings("platform") ?: emptyList()))
      return fail("location", "The location block requires location in requires.platform")
    val permissions = (requires?.get("permissions") as? JsonArray).orEmpty()
    if (permissions.none { (it as? JsonObject)?.text("name") == "location" })
      return fail(
        "location",
        "The location block requires permission location in requires.permissions",
      )
    return null
  }
}
