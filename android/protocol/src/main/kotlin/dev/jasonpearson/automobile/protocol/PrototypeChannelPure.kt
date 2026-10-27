package dev.jasonpearson.automobile.protocol

import kotlin.math.floor
import kotlin.math.min
import kotlin.math.pow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The pure rules of realtime channels (#14261), Kotlin twins of `prototypeChannelBackoff.ts` and
 * `prototypeChannelCoalesce.ts`. Both replay the shared vectors under
 * `test/fixtures/prototype-spec/realtime`.
 */
object PrototypeChannelBackoff {
  const val DEFAULT_MAX_ATTEMPTS = 8
  const val DEFAULT_INITIAL_DELAY_MS = 500
  const val DEFAULT_MAX_DELAY_MS = 30000

  /**
   * The wait before reconnect attempt [attempt] (1 for the first retry): `floor(random * ceiling)`
   * with `ceiling = min(maxDelayMs, initialDelayMs * 2^(attempt-1))`, or null once [attempt]
   * exceeds `maxAttempts` (0 never reconnects) or is below 1. [random] is in `[0, 1)`.
   */
  fun delayMs(
    attempt: Int,
    maxAttempts: Int?,
    initialDelayMs: Int?,
    maxDelayMs: Int?,
    random: () -> Double,
  ): Int? {
    if (attempt < 1 || attempt > (maxAttempts ?: DEFAULT_MAX_ATTEMPTS)) return null
    val initial = (initialDelayMs ?: DEFAULT_INITIAL_DELAY_MS).toDouble()
    val ceiling =
      floor(min((maxDelayMs ?: DEFAULT_MAX_DELAY_MS).toDouble(), initial * 2.0.pow(attempt - 1)))
    return floor(random() * ceiling).toInt()
  }
}

object PrototypeChannelCoalescer {
  private fun target(action: JsonObject): String? {
    fun text(key: String) = (action[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
    return when (text("type")) {
      "setData" -> text("path")?.let { "data:$it" }
      "setState" -> text("key")?.let { "state:$it" }
      else -> null
    }
  }

  /** The sorted, deduplicated targets of a frame made only of coalescable writes, else null. */
  private fun signature(frame: JsonArray): List<String>? {
    val targets = frame.map { (it as? JsonObject)?.let(::target) }
    return if (targets.isEmpty() || targets.any { it == null }) null
    else targets.filterNotNull().toSortedSet().toList()
  }

  /**
   * One flush window's frames with each run of same-target `setData` / `setState` frames reduced to
   * its last frame; appends and every other action are never coalesced.
   */
  fun coalesce(frames: List<JsonArray>): List<JsonArray> {
    val kept = ArrayList<JsonArray>()
    var previous: List<String>? = null
    for (frame in frames) {
      val signature = signature(frame)
      if (signature != null && signature == previous) kept[kept.size - 1] = frame
      else kept.add(frame)
      previous = signature
    }
    return kept
  }
}
