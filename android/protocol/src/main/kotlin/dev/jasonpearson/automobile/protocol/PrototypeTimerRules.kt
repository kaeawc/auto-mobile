package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text

/** Static checks in expanded contract order. An undeclared cancel is deliberately a valid no-op. */
internal object PrototypeTimerRules {
  fun error(context: PrototypeStateChecks.Context): PrototypeSpecError? {
    val ids = linkedSetOf<String>()
    for ((action, path) in context.actions) {
      val type = action.text("type")
      if (type != "startTimer" && type != "cancelTimer") continue
      if (action.text("id").isNullOrEmpty()) return fail("$path.id", "Expected non-empty timer id")
      if (type != "startTimer") continue
      if ("maxRuns" in action && "everyMs" !in action)
        return fail("$path.maxRuns", "maxRuns requires everyMs")
      ids.add(checkNotNull(action.text("id")))
      if (ids.size > PrototypeSpecValidator.MAX_PROTOTYPE_TIMERS)
        return fail("$path.id", "Too many distinct timer ids")
    }
    return null
  }
}
