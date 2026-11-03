package dev.jasonpearson.automobile.protocol

/**
 * Queue semantics for a queued media player (#14249): the pure state machine behind `media.next`,
 * `previous`, `skipTo`, `setShuffle`, `setRepeat`, `setRate` and `setSleepTimer`, the twin of
 * Swift's `PrototypeQueue`. Both replay `test/fixtures/prototype-media-queue`.
 *
 * - The play order is the queue order, or a shuffle that keeps the current item first. Shuffling is
 *   a Fisher-Yates pass driven by the injected [Random], so a fake makes it deterministic.
 * - An explicit `next` ignores repeat `one`; `ended` replays the item under it. Past the last item,
 *   repeat `all` wraps and repeat `off` stops on the last item.
 * - `previous` restarts the item when more than [PREVIOUS_RESTART_MS] in; at the first item it
 *   wraps under repeat `all` and otherwise restarts.
 * - A sleep timer counts down on the renderer's clock through [Op.Advance] and pauses at zero;
 *   `endOfItem` pauses when the current item ends instead of advancing.
 * - [Op.Sync] replaces the item ids after a data action edits the queue. Removing the current item
 *   moves to the next surviving one; with none left it wraps under repeat `all` and otherwise stops
 *   on the last item.
 */
object PrototypeQueue {
  const val PREVIOUS_RESTART_MS: Long = 3_000

  /** Randomness for shuffling: an integer in `0 until bound`. */
  fun interface Random {
    fun nextInt(bound: Int): Int
  }

  enum class Repeat(val wire: String) {
    OFF("off"),
    ONE("one"),
    ALL("all");

    companion object {
      fun fromWire(value: String): Repeat? = entries.firstOrNull { it.wire == value }
    }
  }

  sealed interface Sleep {
    data class Timer(val remainingMs: Long) : Sleep

    data object EndOfItem : Sleep
  }

  data class State(
    /** Item ids in queue (`/data`) order. */
    val items: List<String>,
    /** Item ids in play order: [items], or a shuffle of them. */
    val order: List<String>,
    val currentItemId: String?,
    val playing: Boolean = false,
    val positionMs: Long = 0,
    val shuffle: Boolean = false,
    val repeat: Repeat = Repeat.OFF,
    val rate: Double = 1.0,
    val sleep: Sleep? = null,
  ) {
    /** The current item's index in queue order, or -1 with no current item. */
    val currentIndex: Int
      get() = currentItemId?.let(items::indexOf) ?: -1

    val sleepRemainingMs: Long?
      get() = (sleep as? Sleep.Timer)?.remainingMs
  }

  sealed interface Op {
    data object Play : Op

    data object Pause : Op

    /** The engine reports the playhead. */
    data class Seek(val positionMs: Long) : Op

    data object Next : Op

    data object Previous : Op

    data class SkipTo(val itemId: String) : Op

    data class SetShuffle(val shuffle: Boolean) : Op

    data class SetRepeat(val repeat: Repeat) : Op

    data class SetRate(val rate: Double) : Op

    /** `ms` 0 cancels; [endOfItem] pauses at the end of the current item. */
    data class SetSleepTimer(val ms: Long = 0, val endOfItem: Boolean = false) : Op

    /** The engine reports that the current item played to its end. */
    data object Ended : Op

    /** The renderer's clock advanced. */
    data class Advance(val ms: Long) : Op

    /** A data action replaced the queue's item ids. */
    data class Sync(val items: List<String>) : Op
  }

  /** [itemChanged] means `media.itemChanged` fires; [error] is a stable call error code. */
  data class Result(val state: State, val itemChanged: Boolean = false, val error: String? = null)

  const val ITEM_NOT_FOUND: String = "item_not_found"

  fun start(items: List<String>): State {
    val ids = items.distinct()
    return State(items = ids, order = ids, currentItemId = ids.firstOrNull())
  }

  fun apply(state: State, op: Op, random: Random): Result =
    when (op) {
      Op.Play -> Result(state.copy(playing = state.currentItemId != null))
      Op.Pause -> Result(state.copy(playing = false))
      is Op.Seek -> Result(state.copy(positionMs = op.positionMs))
      Op.Next -> next(state)
      Op.Previous -> previous(state)
      is Op.SkipTo ->
        if (op.itemId in state.items) moveTo(state, op.itemId)
        else Result(state, error = ITEM_NOT_FOUND)
      is Op.SetShuffle -> Result(shuffled(state, op.shuffle, random))
      is Op.SetRepeat -> Result(state.copy(repeat = op.repeat))
      is Op.SetRate -> Result(state.copy(rate = op.rate))
      is Op.SetSleepTimer ->
        Result(
          state.copy(
            sleep =
              when {
                op.endOfItem -> Sleep.EndOfItem
                op.ms > 0 -> Sleep.Timer(op.ms)
                else -> null
              },
          ),
        )
      Op.Ended -> ended(state)
      is Op.Advance -> Result(advanced(state, op.ms))
      is Op.Sync -> sync(state, op.items.distinct())
    }

  private fun moveTo(state: State, itemId: String?, playing: Boolean = state.playing): Result =
    Result(
      state.copy(currentItemId = itemId, positionMs = 0, playing = playing && itemId != null),
      itemChanged = itemId != state.currentItemId,
    )

  /** The item after the current one in play order, wrapping under repeat `all`. */
  private fun following(state: State): String? {
    val position = state.order.indexOf(state.currentItemId)
    return state.order.getOrNull(position + 1)
      ?: state.order.firstOrNull().takeIf { state.repeat == Repeat.ALL }
  }

  private fun next(state: State): Result {
    if (state.currentItemId == null) return Result(state)
    val target = following(state) ?: return Result(state.copy(playing = false))
    return moveTo(state, target)
  }

  private fun previous(state: State): Result {
    if (state.currentItemId == null) return Result(state)
    if (state.positionMs > PREVIOUS_RESTART_MS) return Result(state.copy(positionMs = 0))
    val position = state.order.indexOf(state.currentItemId)
    val target =
      state.order.getOrNull(position - 1)
        ?: state.order.last().takeIf { state.repeat == Repeat.ALL }
        ?: state.currentItemId
    return moveTo(state, target)
  }

  private fun ended(state: State): Result {
    if (state.currentItemId == null) return Result(state)
    return when {
      state.sleep == Sleep.EndOfItem -> Result(state.copy(playing = false, sleep = null))
      state.repeat == Repeat.ONE -> Result(state.copy(positionMs = 0))
      else -> following(state)?.let { moveTo(state, it) } ?: Result(state.copy(playing = false))
    }
  }

  private fun advanced(state: State, ms: Long): State {
    val timer = state.sleep as? Sleep.Timer ?: return state
    val remaining = timer.remainingMs - ms
    return if (remaining > 0) state.copy(sleep = Sleep.Timer(remaining))
    else state.copy(sleep = null, playing = false)
  }

  private fun shuffled(state: State, shuffle: Boolean, random: Random): State {
    if (shuffle == state.shuffle) return state
    if (!shuffle) return state.copy(shuffle = false, order = state.items)
    val rest = state.items.filter { it != state.currentItemId }.toMutableList()
    for (i in rest.lastIndex downTo 1) {
      java.util.Collections.swap(rest, i, random.nextInt(i + 1))
    }
    return state.copy(shuffle = true, order = listOfNotNull(state.currentItemId) + rest)
  }

  private fun sync(state: State, items: List<String>): Result {
    val kept = items.toSet()
    val order =
      if (state.shuffle) state.order.filter { it in kept } + items.filter { it !in state.order }
      else items
    val synced = state.copy(items = items, order = order)
    val current = state.currentItemId
    return when {
      current == null -> moveTo(synced, items.firstOrNull())
      current in kept -> Result(synced)
      else -> {
        val position = state.order.indexOf(current)
        val target =
          state.order.drop(position + 1).firstOrNull { it in kept }
            ?: items.firstOrNull { it !in state.order }
        when {
          target != null -> moveTo(synced, target)
          state.repeat == Repeat.ALL -> moveTo(synced, order.firstOrNull())
          else -> moveTo(synced, order.lastOrNull(), playing = false)
        }
      }
    }
  }
}
