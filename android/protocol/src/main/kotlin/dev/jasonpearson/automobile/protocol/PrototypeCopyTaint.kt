package dev.jasonpearson.automobile.protocol

import dev.jasonpearson.automobile.protocol.PrototypeValidationPaths.text
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Copy propagation through data pointers and state keys; null means the check cap was spent. */
internal object PrototypeCopyTaint {
  private const val MAX_CHECKS = 4_000_000L
  private val DATA_WRITES = setOf("setData", "appendData", "prependData", "upsertData")

  data class Taints(val data: List<String>, val state: List<String>)

  private data class Copy(
    val into: String,
    val source: String,
    val from: String,
    val intoState: Boolean = false,
  )

  private data class Taint(val at: String, val state: Boolean = false)

  private class Walk(
    seeds: List<String>,
    val overlaps: (String, String, Boolean) -> Boolean,
    val maxChecks: Long,
  ) {
    val taints = seeds.toMutableList()
    val stateTaints = mutableListOf<String>()
    private val known = seeds.toMutableSet()
    private val knownState = mutableSetOf<String>()
    private val queue = ArrayDeque(seeds.map { Taint(it) })
    var checks = 0L
    val data = mutableMapOf<String, MutableList<Copy>>()
    val state = mutableMapOf<String, MutableList<Copy>>()
    val templatedState = mutableListOf<Copy>()

    fun mark(copy: Copy) {
      val seen = if (copy.intoState) knownState else known
      if (seen.add(copy.into)) {
        (if (copy.intoState) stateTaints else taints).add(copy.into)
        queue.add(Taint(copy.into, copy.intoState))
      }
    }

    private fun drain(bucket: MutableList<Copy>, hit: (Copy) -> Boolean) {
      checks += bucket.size
      bucket.removeAll { copy ->
        val reached = hit(copy)
        if (reached) mark(copy)
        reached
      }
    }

    private fun drainData(taint: String) {
      val key = firstSegment(taint)
      // A leading {index} taint segment matches any source segment.
      for (name in if (key == "{index}") data.keys.toList() else listOf(key)) {
        data[name]?.let { bucket -> drain(bucket) { overlaps(taint, it.from, false) } }
      }
    }

    private fun drainState(taint: String) {
      for (name in if ('{' in taint) state.keys.toList() else listOf(taint)) {
        state[name]?.let { bucket ->
          drain(bucket) { PrototypeStateTaintIndex.overlaps(taint, it.from) }
        }
      }
      drain(templatedState) { PrototypeStateTaintIndex.overlaps(taint, it.from) }
    }

    fun drain() {
      while (queue.isNotEmpty() && checks <= maxChecks) {
        val taint = queue.removeFirst()
        if (taint.state) drainState(taint.at) else drainData(taint.at)
      }
    }

    fun add(copy: Copy, platformTaints: List<String>) {
      when (copy.source) {
        "data" -> data.getOrPut(firstSegment(copy.from)) { mutableListOf() }.add(copy)
        "state" ->
          if ('{' in copy.from) templatedState.add(copy)
          else state.getOrPut(copy.from) { mutableListOf() }.add(copy)
        else -> {
          checks += platformTaints.size
          if (platformTaints.any { overlaps(it, copy.from, false) }) mark(copy)
        }
      }
    }
  }

  fun propagate(
    seeds: List<String>,
    platformTaints: List<String>,
    context: PrototypeStateChecks.Context,
    overlaps: (String, String, Boolean) -> Boolean,
    maxChecks: Long = MAX_CHECKS,
  ): Taints? {
    val walk = Walk(seeds, overlaps, maxChecks)
    for (copy in copies(context)) walk.add(copy, platformTaints)
    walk.drain()
    return if (walk.checks > maxChecks) null else Taints(walk.taints, walk.stateTaints)
  }

  private fun copies(context: PrototypeStateChecks.Context): List<Copy> =
    context.actions
      .flatMap { action ->
        val state = action.value.text("type") == "setState"
        val into =
          if (state) action.value.text("key")
          else if (action.value.text("type") in DATA_WRITES)
            action.value.text("path")?.let(PrototypeDataWriter::pathPointer)
          else null
        if (into == null) return@flatMap emptyList()
        val raw = action.value["value"]
        val read = raw as? JsonObject
        val sources =
          if (state) stateReads(raw, action.path, context)
          else
            listOf("data", "platform", "state").mapNotNull { source ->
              read?.text(source)?.let { source to it }
            } + if (read?.text("item") != null) repeatReads(action.path, context) else emptyList()
        sources.map { (source, from) -> Copy(into, source, from, state) }
      }
      .sortedBy { it.intoState }

  private fun stateReads(
    raw: JsonElement?,
    path: String,
    context: PrototypeStateChecks.Context,
  ): List<Pair<String, String>> {
    (raw as? JsonObject)?.text("platform")?.let {
      return listOf("platform" to it)
    }
    val text = (raw as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return emptyList()
    return listOf("data", "platform").flatMap { source ->
      PrototypeDataText.pointers(text, source).map { source to it }
    } + repeatReads(path, context, text)
  }

  private fun repeatReads(
    path: String,
    context: PrototypeStateChecks.Context,
    text: String? = null,
  ): List<Pair<String, String>> =
    context.nodes.mapNotNull { node ->
      val repeat = node.value["repeat"] as? JsonObject
      val pointer = (repeat?.get("items") as? JsonObject)?.text("path")
      val alias = repeat?.text("as")
      if (pointer == null || alias == null) return@mapNotNull null
      if (!PrototypeDataPointer.isValid(pointer) || !path.startsWith("${node.path}.children["))
        return@mapNotNull null
      if (text != null && PrototypeRepeatTemplate.fieldReferences(text, alias).isEmpty())
        return@mapNotNull null
      "data" to pointer
    }

  private fun firstSegment(pointer: String): String = pointer.drop(1).substringBefore('/')
}
