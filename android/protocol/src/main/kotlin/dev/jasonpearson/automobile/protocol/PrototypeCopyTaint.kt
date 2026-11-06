package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonObject

/**
 * R2 copy propagation: a data action copying a tainted `/data` or sensitive `/platform` read into
 * `/data` taints its destination, transitively. A worklist over copies bucketed by their source's
 * first segment keeps long chains linear; a null result means the check cap was exceeded, so
 * callers fail closed.
 */
internal object PrototypeCopyTaint {
  private const val MAX_CHECKS = 4_000_000L
  private val DATA_WRITES = setOf("setData", "appendData", "prependData", "upsertData")

  private data class Copy(val into: String, val source: String, val from: String)

  private class Walk(
    seeds: List<String>,
    val overlaps: (String, String, Boolean) -> Boolean,
  ) {
    val taints = seeds.toMutableList()
    val known = seeds.toMutableSet()
    val queue = ArrayDeque(seeds)
    var checks = 0L
    val buckets = mutableMapOf<String, MutableList<Copy>>()

    fun mark(pointer: String) {
      if (known.add(pointer)) {
        taints.add(pointer)
        queue.add(pointer)
      }
    }

    fun drain() {
      while (queue.isNotEmpty() && checks <= MAX_CHECKS) {
        val taint = queue.removeFirst()
        val key = firstSegment(taint)
        // A leading {index} taint segment matches any source segment.
        for (name in if (key == "{index}") buckets.keys.toList() else listOf(key)) {
          val bucket = buckets[name].orEmpty()
          checks += bucket.size
          val (hit, rest) = bucket.partition { overlaps(taint, it.from, false) }
          hit.forEach { mark(it.into) }
          buckets[name] = rest.toMutableList()
        }
      }
    }
  }

  fun propagate(
    seeds: List<String>,
    platformTaints: List<String>,
    context: PrototypeStateChecks.Context,
    overlaps: (String, String, Boolean) -> Boolean,
  ): List<String>? {
    val walk = Walk(seeds, overlaps)
    for (copy in copies(context)) {
      if (copy.source == "data") {
        walk.buckets.getOrPut(firstSegment(copy.from)) { mutableListOf() }.add(copy)
      } else {
        walk.checks += platformTaints.size
        if (platformTaints.any { overlaps(it, copy.from, false) }) walk.mark(copy.into)
      }
    }
    walk.drain()
    return if (walk.checks > MAX_CHECKS) null else walk.taints
  }

  private fun copies(context: PrototypeStateChecks.Context): List<Copy> =
    context.actions
      .filter { it.value.text("type") in DATA_WRITES }
      .flatMap { action ->
        val into =
          action.value.text("path")?.let(PrototypeDataWriter::pathPointer)
            ?: return@flatMap emptyList()
        val read = action.value["value"] as? JsonObject
        val data = read?.text("data")
        val platform = read?.text("platform")
        when {
          data != null -> listOf(Copy(into, "data", data))
          platform != null -> listOf(Copy(into, "platform", platform))
          read?.text("item") != null ->
            context.nodes.mapNotNull { node ->
              val repeat = node.value["repeat"] as? JsonObject
              val pointer = (repeat?.get("items") as? JsonObject)?.text("path")
              pointer
                ?.takeIf {
                  action.path.startsWith("${node.path}.children[") &&
                    repeat != null && repeat.text("as") != null &&
                    PrototypeDataPointer.isValid(it)
                }
                ?.let { Copy(into, "data", it) }
            }
          else -> emptyList()
        }
      }

  private fun firstSegment(pointer: String): String = pointer.drop(1).substringBefore('/')
}
