package dev.jasonpearson.automobile.ctrlproxy.pointer

import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull

/**
 * The request the host sends in the instrumentation's `request` argument: base64 of this JSON.
 * Base64 keeps it a single shell-safe token for `am instrument -e request <token>`.
 *
 * ```json
 * {"version":1,"tool":"stylus","hover":true,"buttons":0,"displayId":0,
 *  "points":[{"x":10,"y":20,"durationMs":120,"distance":0.4}]}
 * ```
 */
internal sealed interface PointerRequestParse {
  data class Parsed(val request: PointerInjectionRequest) : PointerRequestParse

  data class Rejected(val error: String) : PointerRequestParse
}

@OptIn(ExperimentalEncodingApi::class)
internal object PointerRequestCodec {
  const val VERSION = 1
  const val ARGUMENT = "request"

  fun decodeBase64(token: String?): PointerRequestParse {
    if (token.isNullOrEmpty())
      return PointerRequestParse.Rejected("the request argument is missing")
    val text =
      try {
        Base64.Default.decode(token).toString(Charsets.UTF_8)
      } catch (error: IllegalArgumentException) {
        return PointerRequestParse.Rejected("the request is not valid base64: ${error.message}")
      }
    return decode(text)
  }

  fun decode(text: String): PointerRequestParse {
    val root =
      try {
        Json.parseToJsonElement(text).jsonObject
      } catch (error: IllegalArgumentException) {
        // SerializationException is an IllegalArgumentException, as is a non-object element.
        return PointerRequestParse.Rejected("the request is not a JSON object: ${error.message}")
      }
    if (root.int("version") != VERSION) {
      return PointerRequestParse.Rejected("unsupported request version ${root["version"]}")
    }
    val tool =
      PointerTool.fromWire(root.string("tool"))
        ?: return PointerRequestParse.Rejected("tool must be \"stylus\" or \"mouse\"")
    val pointArray =
      root["points"] as? JsonArray ?: return PointerRequestParse.Rejected("points must be an array")
    val points = mutableListOf<PointerWaypoint>()
    for ((index, element) in pointArray.withIndex()) {
      val point =
        (element as? JsonObject)?.let(::waypoint)
          ?: return PointerRequestParse.Rejected("points[$index] must have numeric x and y")
      points += point
    }
    val request =
      PointerInjectionRequest(
        tool = tool,
        hover = root.bool("hover") ?: false,
        points = points,
        buttons = root.int("buttons") ?: 0,
        displayId = root.int("displayId") ?: 0,
      )
    return PointerInjectionPlanner.validate(request)?.let { PointerRequestParse.Rejected(it) }
      ?: PointerRequestParse.Parsed(request)
  }

  private fun waypoint(point: JsonObject): PointerWaypoint? {
    val x = point.float("x") ?: return null
    val y = point.float("y") ?: return null
    return PointerWaypoint(
      x = x,
      y = y,
      durationMs = point["durationMs"]?.let { (it as? JsonPrimitive)?.longOrNull } ?: 0,
      pressure = point.float("pressure"),
      distance = point.float("distance"),
      tilt = point.float("tilt"),
      orientation = point.float("orientation"),
    )
  }

  private fun JsonObject.float(key: String): Float? =
    (this[key] as? JsonPrimitive)?.doubleOrNull?.toFloat()

  private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.intOrNull

  private fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

  private fun JsonObject.string(key: String): String? =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
}
