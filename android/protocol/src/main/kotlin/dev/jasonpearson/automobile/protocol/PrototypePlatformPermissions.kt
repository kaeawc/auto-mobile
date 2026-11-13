package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** How the host grants an Android permission before launch (#14297). */
enum class AndroidPermissionGrant(val wire: String) {
  /** `pm grant` per manifest permission. */
  PM_GRANT("pmGrant"),
  /** Toggle the app's notification setting; POST_NOTIFICATIONS is not a `pm grant` target. */
  NOTIFICATIONS("notifications"),
  /** No runtime grant exists. */
  NONE("none"),
}

/** Android half of one mapping entry. */
data class AndroidPermissionMapping(
  val manifest: List<String>,
  val grant: AndroidPermissionGrant,
)

/** iOS half of one mapping entry; a null [simctlService] means a simulator cannot grant it. */
data class IosPermissionMapping(val usageKey: String?, val simctlService: String?)

data class PrototypePermissionMapping(
  val android: AndroidPermissionMapping,
  val ios: IosPermissionMapping,
)

/**
 * Reader for `schemas/prototype-platform-permissions.json`, the same file TypeScript and Swift
 * read: each canonical permission name to its Android manifest permissions and grant mechanism, and
 * its iOS usage key and `simctl privacy` service. Names are in contract order.
 */
object PrototypePlatformPermissions {
  private val mapping: Map<String, PrototypePermissionMapping> =
    parse(
      checkNotNull(javaClass.getResourceAsStream("/prototype-platform-permissions.json")) {
          "Missing prototype platform permission mapping"
        }
        .bufferedReader()
        .use { it.readText() },
    )

  /** Canonical permission names, in the order the JSON file (and the spec contract) lists them. */
  val names: List<String> = mapping.keys.toList()

  fun mappingFor(name: String): PrototypePermissionMapping? = mapping[name]

  internal fun parse(text: String): Map<String, PrototypePermissionMapping> =
    Json.parseToJsonElement(text).jsonObject.mapValues { (_, entry) -> entry(entry.jsonObject) }

  private fun entry(entry: JsonObject): PrototypePermissionMapping {
    val android = entry.getValue("android").jsonObject
    val ios = entry.getValue("ios").jsonObject
    val grant = android.getValue("grant").jsonPrimitive.content
    return PrototypePermissionMapping(
      android =
        AndroidPermissionMapping(
          manifest = android.getValue("manifest").jsonArray.map { it.jsonPrimitive.content },
          grant =
            checkNotNull(AndroidPermissionGrant.entries.firstOrNull { it.wire == grant }) {
              "Unknown Android permission grant: $grant"
            },
        ),
      ios = IosPermissionMapping(nullable(ios, "usageKey"), nullable(ios, "simctlService")),
    )
  }

  private fun nullable(obj: JsonObject, key: String): String? =
    obj.getValue(key).takeUnless { it is JsonNull }?.jsonPrimitive?.content
}
