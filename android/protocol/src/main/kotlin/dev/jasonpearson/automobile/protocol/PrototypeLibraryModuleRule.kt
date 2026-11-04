package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.flag
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject

/** R1: a library spec reaches no `sensitive` platform call or event handler. */
internal object PrototypeLibraryModuleRule {
  /** R2 sinks, then R1 modules: TypeScript's library order. */
  fun sensitiveError(spec: JsonObject, context: PrototypeStateChecks.Context): PrototypeSpecError? =
    PrototypeSensitiveSinkRules.errors(spec, context).firstOrNull() ?: error(spec, context)

  fun error(spec: JsonObject, context: PrototypeStateChecks.Context): PrototypeSpecError? {
    for (use in PrototypePlatformUses.uses(spec, context)) {
      if (use is PrototypePlatformUses.Use.Call) {
        val call = use.action.text("call")
        if (PrototypePlatformModules.sensitiveCall(call))
          return PrototypeSpecError(
            use.path,
            "Sensitive platform call $call is unavailable in a library",
          )
      }
      if (
        use is PrototypePlatformUses.Use.Handler &&
          PrototypePlatformModules.eventDefinition(use.event)?.flag("sensitive") == true
      )
        return PrototypeSpecError(
          use.path,
          "Sensitive platform event ${use.event} is unavailable in a library",
        )
    }
    return null
  }
}
