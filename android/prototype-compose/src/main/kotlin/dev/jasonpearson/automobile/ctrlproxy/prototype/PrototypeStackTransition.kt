package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypeStackNode
import dev.jasonpearson.automobile.protocol.PrototypeStackTransition
import dev.jasonpearson.automobile.protocol.stackTransition
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow

internal enum class StackTransitionKind {
  Slide,
  Fade,
  SharedAxisX,
  SharedAxisY,
  FadeThrough,
  Zoom,
  None,
}

@InternalAutoMobilePrototypeApi
data class PrototypeStackChange(
  val id: String,
  val direction: String,
  val override: PrototypeStackTransition? = null,
  val sequence: Long = 0,
  val source: String? = null,
  val zoomTarget: Pair<Int, String>? = null,
)

internal fun resolveStackTransition(
  declared: PrototypeStackTransition?,
  perAction: PrototypeStackTransition?,
  motionEnabled: Boolean,
  reducedMotion: Boolean,
): StackTransitionKind {
  val chosen = perAction ?: declared ?: PrototypeStackTransition.PLATFORM
  if (!motionEnabled || chosen == PrototypeStackTransition.NONE) return StackTransitionKind.None
  if (reducedMotion) return StackTransitionKind.Fade
  return when (chosen) {
    PrototypeStackTransition.NONE -> StackTransitionKind.None
    PrototypeStackTransition.FADE -> StackTransitionKind.Fade
    PrototypeStackTransition.SHARED_AXIS_X -> StackTransitionKind.SharedAxisX
    PrototypeStackTransition.SHARED_AXIS_Y -> StackTransitionKind.SharedAxisY
    PrototypeStackTransition.ZOOM -> StackTransitionKind.Zoom
    PrototypeStackTransition.FADE_THROUGH -> StackTransitionKind.FadeThrough
    PrototypeStackTransition.PLATFORM,
    PrototypeStackTransition.SLIDE -> StackTransitionKind.Slide
  }
}

internal data class StackAnimation(
  val kind: StackTransitionKind,
  val direction: String,
  val fadeThrough: Boolean,
)

internal fun resolveStackAnimation(
  declared: PrototypeStackTransition?,
  change: PrototypeStackChange?,
  motion: Boolean,
  reduced: Boolean,
): StackAnimation {
  val direction = change?.direction ?: "push"
  val chosen = change?.override ?: declared ?: PrototypeStackTransition.PLATFORM
  val fadeThrough =
    direction == "replace" && chosen == PrototypeStackTransition.PLATFORM && motion && !reduced
  val kind =
    if (fadeThrough) StackTransitionKind.Fade
    else resolveStackTransition(declared, change?.override, motion, reduced)
  return StackAnimation(kind, direction, fadeThrough)
}

private const val STACK_PARALLAX = 0.3f

internal fun stackSlideOffset(width: Int, rtl: Boolean): Int = if (rtl) -width else width

internal fun stackEnterOffset(width: Int, pop: Boolean, rtl: Boolean): Int =
  stackSlideOffset(if (pop) -(width * STACK_PARALLAX).toInt() else width, rtl)

internal fun stackExitOffset(width: Int, pop: Boolean, rtl: Boolean): Int =
  stackSlideOffset(if (pop) width else -(width * STACK_PARALLAX).toInt(), rtl)

/** Prefix ownership prevents a new entry at a reused position inheriting the old entry's scroll. */
internal class PrototypeStackScrollStore {
  private data class Key(val position: Int, val screen: String, val node: String)

  private var path: List<String> = emptyList()
  private val values = mutableMapOf<Key, Int>()
  private val lists = mutableMapOf<Key, PrototypeListAnchor>()

  fun retain(next: List<String>) {
    val common = path.zip(next).takeWhile { (before, after) -> before == after }.size
    values.keys.removeAll { it.position >= common }
    lists.keys.removeAll { it.position >= common }
    path = next.toList()
  }

  fun readList(position: Int, screen: String, node: String): PrototypeListAnchor? =
    lists[Key(position, screen, node)]

  fun saveList(position: Int, screen: String, node: String, anchor: PrototypeListAnchor) {
    if (path.getOrNull(position) == screen) lists[Key(position, screen, node)] = anchor
  }

  fun read(position: Int, screen: String, node: String): Int =
    values[Key(position, screen, node)] ?: 0

  fun save(position: Int, screen: String, node: String, value: Int) {
    if (path.getOrNull(position) == screen) values[Key(position, screen, node)] = value
  }
}

/** Completion commits even on pre-34 dispatch with no progress; cancellation never commits. */
internal suspend fun collectStackBackProgress(
  progress: Flow<Float>,
  seek: suspend (Float) -> Unit,
): Boolean =
  try {
    progress.collect { seek(it.coerceIn(0f, 1f)) }
    true
  } catch (_: CancellationException) {
    false
  }

/** Owned by the runtime composition, including stacks on currently covered outer screens. */
internal class PrototypeStackScrollStores {
  private val stores = mutableMapOf<String, PrototypeStackScrollStore>()

  fun retain(paths: Map<String, List<String>>) {
    stores.keys.retainAll(paths.keys)
    paths.forEach { (id, path) -> get(id).retain(path) }
  }

  fun get(id: String): PrototypeStackScrollStore =
    stores.getOrPut(id) { PrototypeStackScrollStore() }
}

internal fun resolveStackSnapshotAnimation(
  source: PrototypeStackNode,
  snapshot: PrototypeRuntimeSnapshot?,
  motion: Boolean,
  reduced: Boolean,
): StackTransitionKind =
  resolveStackAnimation(
      source.stackTransition,
      snapshot?.stackChange?.takeIf { it.id == source.id },
      motion,
      reduced,
    )
    .kind
