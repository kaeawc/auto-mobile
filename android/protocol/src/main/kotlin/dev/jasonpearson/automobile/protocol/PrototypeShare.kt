package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypePlatformModules.member
import kotlinx.serialization.json.*

/** The only resolution failure is a typed platform invalid_args outcome, before any UI. */
data class PrototypeShareError(val path: String, val message: String) {
  val code: String = "invalid_args"
}

sealed interface PrototypeShareResolution {
  data class Resolved(val payload: JsonObject, val summary: JsonObject) : PrototypeShareResolution

  data class Failure(val error: PrototypeShareError) : PrototypeShareResolution

  fun toJson(): JsonObject =
    when (this) {
      is Resolved ->
        buildJsonObject {
          put("ok", true)
          put("payload", payload)
          put("summary", summary)
        }
      is Failure ->
        buildJsonObject {
          put("ok", false)
          putJsonObject("error") {
            put("code", error.code)
            put("path", error.path)
            put("message", error.message)
          }
        }
    }
}

/** Pure share contract; intentionally does not register a system-sheet driver. */
object PrototypeShare {
  val MAX_PROTOTYPE_SHARE_TEXT_BYTES =
    PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_SHARE_TEXT_BYTES").jsonPrimitive.int
  val MAX_PROTOTYPE_SHARE_IMAGES =
    PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_SHARE_IMAGES").jsonPrimitive.int
  val MAX_PROTOTYPE_SHARE_FILES =
    PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_SHARE_FILES").jsonPrimitive.int

  internal fun platformArgumentsError(
    call: String?,
    action: JsonObject,
    path: String,
  ): PrototypeSpecError? =
    when (call) {
      "share.open" -> argumentsError(action.member("args") ?: JsonObject(emptyMap()), "$path.args")
      "links.open" ->
        PrototypeLinks.argumentsError(action.member("args") ?: JsonObject(emptyMap()), "$path.args")
      else -> null
    }

  fun argumentsError(
    args: JsonObject,
    path: String,
    assets: Set<String>? = null,
    resolved: Boolean = false,
  ): PrototypeSpecError? = PrototypeShareValidation.argumentsError(args, path, assets, resolved)

  fun resolvePrototypeShare(args: JsonObject, inputs: JsonObject): PrototypeShareResolution =
    PrototypeShareResolver.resolvePrototypeShare(args, inputs)
}
