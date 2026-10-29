package dev.jasonpearson.automobile.protocol

import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonPrimitive

/**
 * Which feed players hold a decoder (#14258): the pure allocation behind `autoplay: "whenVisible"`,
 * the twin of Swift's `PrototypeMediaPool`. Both replay `test/fixtures/prototype-media-pool`.
 *
 * The anchor is the settled pager page, or else the most visible player (ties go to the topmost).
 * The window is the anchor, the next item and the previous item, at most
 * [MAX_PROTOTYPE_ACTIVE_DECODERS]. The anchor plays only in the foreground, and only when its page
 * has settled (pager) or it is at least `visibleThreshold` visible (list). Window players that do
 * not play are preloaded; held players outside the window are released.
 */
object PrototypeMediaPool {
  val MAX_PROTOTYPE_ACTIVE_DECODERS: Int =
    PrototypeSpecContract.limits.getValue("MAX_PROTOTYPE_ACTIVE_DECODERS").jsonPrimitive.int

  /** The visible fraction a list player needs to play when its node omits `visibleThreshold`. */
  const val DEFAULT_VISIBLE_THRESHOLD: Double = 0.6

  enum class Mode {
    PAGER,
    LIST,
  }

  /** One feed player, in layout order: page order for a pager, top to bottom for a list. */
  data class Item(val id: String, val visibleFraction: Double)

  data class Input(
    val mode: Mode,
    val items: List<Item>,
    /** The settled page; `null` while a pager is mid-swipe. Ignored for lists. */
    val settledIndex: Int? = null,
    val visibleThreshold: Double = DEFAULT_VISIBLE_THRESHOLD,
    val foreground: Boolean = true,
    /** The players that hold a decoder now. */
    val held: List<String> = emptyList(),
  )

  data class Allocation(val play: String?, val preload: List<String>, val release: List<String>)

  fun allocate(input: Input): Allocation {
    val items = input.items
    val settled = input.settledIndex?.takeIf { input.mode == Mode.PAGER && it in items.indices }
    val anchor = settled ?: mostVisible(items)
    val window =
      if (anchor == null) emptyList()
      else
        listOf(anchor, anchor + 1, anchor - 1)
          .filter { it in items.indices }
          .take(MAX_PROTOTYPE_ACTIVE_DECODERS)
          .map { items[it].id }
    val playable =
      when (input.mode) {
        Mode.PAGER -> settled != null
        Mode.LIST -> anchor != null && items[anchor].visibleFraction >= input.visibleThreshold
      }
    val play = if (anchor != null && input.foreground && playable) items[anchor].id else null
    return Allocation(
      play = play,
      preload = window.filter { it != play },
      release = input.held.distinct().filter { it !in window },
    )
  }

  /** The index of the most visible item, the topmost on a tie; `null` when nothing is visible. */
  private fun mostVisible(items: List<Item>): Int? =
    items.indices
      .filter { items[it].visibleFraction > 0 }
      .maxWithOrNull(
        compareBy<Int> { items[it].visibleFraction }.thenByDescending { it },
      )
}
