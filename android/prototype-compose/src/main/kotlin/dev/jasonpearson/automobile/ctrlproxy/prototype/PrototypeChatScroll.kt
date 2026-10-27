package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeScalar
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * One pending `scrollTo` (#14232): where to go and whether to animate. [sequence] grows per
 * request, so the same target asked twice still moves the scroll.
 */
@InternalAutoMobilePrototypeApi
data class PrototypeScrollRequest(
  val target: PrototypeScrollTarget,
  val animated: Boolean,
  val sequence: Long,
)

/** A `scrollTo` target: the start, the end, or the row whose `repeat.key` renders as [key]. */
@InternalAutoMobilePrototypeApi
sealed interface PrototypeScrollTarget {
  data object Start : PrototypeScrollTarget

  data object End : PrototypeScrollTarget

  data class Key(val key: String) : PrototypeScrollTarget

  companion object {
    /** The authored `to`, or null for a shape the validator refuses. */
    fun of(to: JsonElement): PrototypeScrollTarget? =
      when {
        to is JsonPrimitive && to.isString && to.content == "start" -> Start
        to is JsonPrimitive && to.isString && to.content == "end" -> End
        to is JsonObject -> (to["key"] as? JsonPrimitive)?.let { Key(scalar(it).renderedText()) }
        else -> null
      }

    private fun scalar(value: JsonPrimitive): PrototypeScalar {
      val flag = value.booleanOrNull
      return when {
        value.isString -> PrototypeScalar.Text(value.content)
        flag != null -> PrototypeScalar.BooleanValue(flag)
        else -> PrototypeScalar.Numeric(value.doubleOrNull ?: 0.0)
      }
    }
  }
}

/**
 * Device-free chat-scroll geometry. `value` and `max` are the scroll's offset and range in pixels;
 * with `reverse` the offset counts from the end, so 0 is the end.
 */
internal object PrototypeChatScroll {
  fun atEnd(value: Int, max: Int, reverse: Boolean): Boolean =
    if (reverse) value <= 0 else value >= max

  /** The start counts only when there is somewhere to scroll, so a short list loads nothing. */
  fun atStart(value: Int, max: Int, reverse: Boolean): Boolean =
    max > 0 && if (reverse) value >= max else value <= 0

  /**
   * Whether to jump to the new end after the content grew: only a forward scroll that was at its
   * end with `stickToEnd`. A reverse scroll is anchored at its end already.
   */
  fun follows(stickToEnd: Boolean, reverse: Boolean, wasAtEnd: Boolean, grew: Boolean): Boolean =
    stickToEnd && !reverse && wasAtEnd && grew

  /**
   * The offset that shows [target]: [rowTop] is a key target's top within the content, null when no
   * such row is laid out (the request is then dropped).
   */
  fun offset(target: PrototypeScrollTarget, max: Int, reverse: Boolean, rowTop: Int?): Int? {
    val forward =
      when (target) {
        PrototypeScrollTarget.Start -> 0
        PrototypeScrollTarget.End -> max
        is PrototypeScrollTarget.Key -> rowTop ?: return null
      }.coerceIn(0, max)
    return if (reverse) max - forward else forward
  }

  /** The `repeat.key` a rendered row stands for, from its identity, or null for any other node. */
  fun rowKey(identity: String): String? =
    Regex("""\.repeat\[(.*)\]\.children\[0\]$""").find(identity)?.groupValues?.get(1)
}
