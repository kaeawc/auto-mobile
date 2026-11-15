package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * R6: the `sensitive` platform modules an imported prototype uses, for ProtoViewer's app-reserved
 * provenance region (#15636). A module counts when the spec calls one of its sensitive calls or
 * handles one of its sensitive events, found by the same walk as R1. R1 refuses these in a library
 * today, so a validated import yields none; the region is the backstop if R1 is relaxed.
 */
object PrototypeLibraryProvenance {
  /** Module names in UTF-16 order; malformed data yields none, since the loader reports it. */
  fun sensitiveModules(spec: String): List<String> {
    val parsed = runCatching { Json.parseToJsonElement(spec) }.getOrNull() as? JsonObject
    return parsed?.let(::sensitiveModules).orEmpty()
  }

  fun sensitiveModules(spec: JsonObject): List<String> =
    PrototypePlatformUses.uses(spec, PrototypeStateChecks.Context())
      .mapNotNull { use ->
        when (use) {
          is PrototypePlatformUses.Use.Call ->
            use.action
              .text("call")
              .takeIf(PrototypePlatformModules::sensitiveCall)
              ?.substringBefore('.')
          is PrototypePlatformUses.Use.Handler ->
            PrototypePlatformModules.eventModule(use.event)?.takeIf {
              PrototypePlatformModules.eventDefinition(use.event)?.flag("sensitive") == true
            }
          else -> null
        }
      }
      .distinct()
      .sorted()
}
