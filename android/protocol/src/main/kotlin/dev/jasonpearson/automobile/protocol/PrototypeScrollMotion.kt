package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Context
import dev.jasonpearson.automobile.protocol.PrototypeStateChecks.Located
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.fail
import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlin.math.abs
import kotlinx.serialization.json.*

/** Scroll-driven draw values are independent of the animation clock. */
object PrototypeScrollMotion {
  const val MAX_PROTOTYPE_SCROLL_BINDINGS = 16

  data class Draw(
    val alpha: Double = 1.0,
    val scale: Double = 1.0,
    val offsetX: Double = 0.0,
    val offsetY: Double = 0.0,
    val blur: Double = 0.0,
  )

  fun draw(linked: PrototypeScrollLinked?, offset: Double, reduced: Boolean): Draw {
    if (linked == null) return Draw()
    fun output(range: List<Double>?, identity: Double) =
      range?.let { interpolate(offset, linked.range, it) } ?: identity
    return Draw(
      alpha = output(linked.alpha, 1.0).coerceIn(0.0, 1.0),
      scale = if (reduced) 1.0 else output(linked.scale, 1.0),
      offsetX = if (reduced) 0.0 else output(linked.offsetX, 0.0),
      offsetY = if (reduced) 0.0 else output(linked.offsetY, 0.0),
      blur = if (reduced) 0.0 else output(linked.blur, 0.0).coerceAtLeast(0.0),
    )
  }

  fun interpolate(offset: Double, range: List<Double>, output: List<Double>): Double {
    if (offset <= range[0]) return output[0]
    if (offset >= range[1]) return output[1]
    val span = range[1] - range[0]
    val fraction =
      if (span.isFinite()) (offset - range[0]) / span
      else (offset / 2 - range[0] / 2) / (range[1] / 2 - range[0] / 2)
    return output[0] * (1 - fraction) + output[1] * fraction
  }

  fun edge(phase: Double, value: Double, identity: Double): Double =
    identity + (value - identity) * abs(phase).coerceIn(0.0, 1.0)

  private fun screen(path: String, scopes: List<String>): String =
    scopes.filter { path == it || path.startsWith("$it.") }.maxByOrNull { it.length } ?: "root"

  private fun instances(node: Located, context: Context, data: PrototypeRepeatData): Int {
    var count = 1
    for (parent in context.nodes) {
      if (!node.path.startsWith("${parent.path}.children[")) continue
      val items = (parent.value["repeat"] as? JsonObject)?.get("items")
      count *=
        when (items) {
          is JsonArray -> items.size
          is JsonObject -> data.items(items.text("path") ?: "").size
          else -> 1
        }
    }
    return count
  }

  private fun linkedError(
    linked: JsonObject,
    node: Located,
    context: Context,
    scopes: List<String>,
  ): PrototypeSpecError? {
    val path = "${node.path}.scrollLinked"
    val range = linked.getValue("range").jsonArray.map { it.jsonPrimitive.double }
    if (range[0] >= range[1]) return fail("$path.range", "Expected two increasing numbers")
    if (listOf("alpha", "scale", "offsetY", "offsetX", "blur").none { it in linked })
      return fail(path, "Expected at least one scroll output")
    val source =
      context.nodes.any {
        it.value.text("id") == linked.text("source") &&
          it.value.text("type") == "scroll" &&
          screen(it.path, scopes) == screen(node.path, scopes)
      }
    return if (source) null else fail("$path.source", "Expected a scroll id in the same screen")
  }

  private fun transitionError(
    node: Located,
    context: Context,
    scopes: List<String>,
  ): PrototypeSpecError? {
    if (node.value["scrollTransition"] == null) return null
    val ancestor =
      context.nodes.any {
        node.path.startsWith("${it.path}.") &&
          screen(it.path, scopes) == screen(node.path, scopes) &&
          (it.value.text("type") in listOf("scroll", "pager", "carousel") || "repeat" in it.value)
      }
    return if (ancestor) null
    else
      fail("${node.path}.scrollTransition", "Expected a scroll, pager, carousel or repeat ancestor")
  }

  internal fun error(context: Context): PrototypeSpecError? {
    var count = 0
    val scopes =
      context.nodes.flatMap { node ->
        (node.value["screens"] as? JsonObject)?.keys.orEmpty().map { name ->
          "${node.path}.screens[${PrototypeSpecInput.canonicalString(name)}]"
        }
      }
    val data = PrototypeRepeatData((context.root as? JsonObject)?.get("data") as? JsonObject)
    for (node in context.nodes) {
      val linked = node.value["scrollLinked"] as? JsonObject
      val bindings = listOfNotNull(linked, node.value["scrollTransition"]).size
      if (bindings == 0) continue
      count += bindings * instances(node, context, data)
      if (count > MAX_PROTOTYPE_SCROLL_BINDINGS)
        return fail(node.path, "Scroll binding limit exceeded")
      val error =
        linked?.let { linkedError(it, node, context, scopes) }
          ?: transitionError(node, context, scopes)
      if (error != null) return error
    }
    return null
  }
}
