package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** How a simulated push reached the runtime: the live connection frame or the system push path. */
enum class PrototypePushRoute {
  CONNECTION,
  SYSTEM,
}

/**
 * What a runtime reports and posts for one simulated push (#14285), the Kotlin twin of TypeScript's
 * `prototypePushDelivery` (`prototypePushDelivery.ts`). All three replay
 * `test/fixtures/prototype-spec/push/traces.json`. `notification` is the system route's delivery;
 * on the connection route an active app is `foreground` and any other app state is `background`. A
 * push no handler takes posts its `notification`, if it has one, as a plain alert.
 */
object PrototypePushDelivery {
  const val EVENT = "notifications.push"

  private val ALERT_FIELDS = listOf("title", "body", "channel", "group", "badge")

  /** [event] is the `prototype_platform_event` payload; [alert] is null when none is posted. */
  data class Outcome(val event: JsonObject, val alert: JsonObject?)

  /**
   * [handled] is whether the spec has a `notifications.push` handler; [payload] is a push the host
   * already validated; [appState] uses the `platformRuntime.appState` vocabulary.
   */
  fun deliver(
    handled: Boolean,
    payload: JsonObject,
    appState: String,
    route: PrototypePushRoute,
  ): Outcome {
    val event = buildJsonObject {
      put("event", EVENT)
      put(
        "data",
        buildJsonObject {
          put("type", payload.getValue("type").jsonPrimitive.content)
          put("delivery", delivery(route, appState))
          put("handled", handled)
        },
      )
      put("simulated", true)
    }
    val notification = payload["notification"] as? JsonObject
    if (handled || notification == null) return Outcome(event, null)
    val alert =
      JsonObject(ALERT_FIELDS.mapNotNull { name -> notification[name]?.let { name to it } }.toMap())
    return Outcome(event, alert)
  }

  /** The `delivery` wire value for [route] while the app is in [appState]. */
  fun delivery(route: PrototypePushRoute, appState: String): String =
    when {
      route == PrototypePushRoute.SYSTEM -> "notification"
      appState == "active" -> "foreground"
      else -> "background"
    }
}
