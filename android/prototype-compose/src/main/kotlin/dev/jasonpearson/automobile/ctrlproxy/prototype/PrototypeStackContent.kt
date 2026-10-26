package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import dev.jasonpearson.automobile.protocol.PrototypeStackNode
import dev.jasonpearson.automobile.protocol.stackTransition
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf

private const val STACK_DURATION_MS = 300
private const val STACK_FADE_THROUGH_MS = STACK_DURATION_MS / 2

internal class PrototypeBackSeek {
  var preview by mutableStateOf<PrototypeRuntimeSnapshot?>(null)
  var progress by mutableFloatStateOf(0f)
  var result by mutableStateOf<Boolean?>(null)

  fun start(snapshot: PrototypeRuntimeSnapshot) {
    progress = 0f
    result = null
    preview = snapshot
  }

  fun clear() {
    preview = null
    result = null
    progress = 0f
  }
}

internal val LocalPrototypeBackSeek = compositionLocalOf<PrototypeBackSeek?> { null }
internal val LocalPrototypeStackScrollStores =
  compositionLocalOf<PrototypeStackScrollStores?> { null }
internal val LocalPrototypeStackRuntime = compositionLocalOf<PrototypeRuntime?> { null }
internal val LocalPrototypeStackSnapshot = compositionLocalOf<PrototypeRuntimeSnapshot?> { null }

private data class ScrollEntry(
  val store: PrototypeStackScrollStore,
  val position: Int,
  val screen: String,
)

private val LocalStackScrollEntry = compositionLocalOf<ScrollEntry?> { null }

@Composable
internal fun rememberStackScrollState(identity: String): ScrollState {
  val entry = LocalStackScrollEntry.current
  val state = rememberScrollState(entry?.store?.read(entry.position, entry.screen, identity) ?: 0)
  if (entry != null) {
    LaunchedEffect(state, entry, identity) {
      snapshotFlow { state.value }
        .collect { entry.store.save(entry.position, entry.screen, identity, it) }
    }
  }
  return state
}

private data class StackFrame(
  val position: Int,
  val screen: String,
  val node: PrototypeRenderNode,
) {
  val key: Pair<Int, String>
    get() = position to screen
}

@Composable
internal fun PrototypeStackContent(
  node: PrototypeRenderNode,
  modifier: Modifier,
  interact: (PrototypeInteraction) -> Unit,
) {
  val source = node.source as PrototypeStackNode
  val snapshot = LocalPrototypeStackSnapshot.current
  val path = snapshot?.stacks?.get(source.id)?.path ?: listOf(source.start)
  val child = node.children.firstOrNull() ?: return
  val frame = StackFrame(path.lastIndex, path.last(), child)
  val store =
    LocalPrototypeStackScrollStores.current?.get(source.id)
      ?: remember(source.id, LocalPrototypeShowEpoch.current) { PrototypeStackScrollStore() }
  store.retain(path)
  val change =
    (LocalPrototypeBackSeek.current?.preview ?: snapshot)?.stackChange?.takeIf {
      it.id == source.id
    }
  val seek = LocalPrototypeBackSeek.current
  val runtime = LocalPrototypeStackRuntime.current
  val preview = seek?.preview?.takeIf { it.stackChange?.id == source.id }
  val motion = LocalPrototypeMotion.current
  val reducedMotion = LocalPrototypeReducedMotion.current
  val animation = resolveStackAnimation(source.stackTransition, change, motion, reducedMotion)
  val rtl = prototypeRtl()
  AnimatedStackContent(
    frame,
    source,
    motion,
    reducedMotion,
    preview,
    runtime,
    seek,
    modifier,
    animation,
    rtl,
    node.style.alignment,
  ) { screen ->
    StackScreen(screen, store, interact)
  }
}

@Composable
private fun StackScreen(
  screen: StackFrame,
  store: PrototypeStackScrollStore,
  interact: (PrototypeInteraction) -> Unit,
) {
  CompositionLocalProvider(
    LocalStackScrollEntry provides ScrollEntry(store, screen.position, screen.screen),
  ) {
    Box(Modifier.semantics { paneTitle = screen.screen }) {
      RenderPrototypeNode(screen.node, interact)
    }
  }
}

@Composable
@Suppress("LongParameterList")
private fun AnimatedStackContent(
  frame: StackFrame,
  source: PrototypeStackNode,
  motion: Boolean,
  reducedMotion: Boolean,
  preview: PrototypeRuntimeSnapshot?,
  runtime: PrototypeRuntime?,
  seek: PrototypeBackSeek?,
  modifier: Modifier,
  animation: StackAnimation,
  rtl: Boolean,
  alignment: Alignment,
  draw: @Composable (StackFrame) -> Unit,
) {
  // One keyed content tree owns screen state through ordinary navigation and back previews.
  val state = remember { SeekableTransitionState(frame) }
  val kind = animation.kind
  val transition = rememberTransition(state, label = "prototype stack")
  var inFlight by remember { mutableStateOf(false) }
  ReportPrototypeMotion {
    kind != StackTransitionKind.None &&
      (preview != null ||
        inFlight ||
        state.currentState != state.targetState ||
        transition.isRunning)
  }
  // Observe runtime changes directly so snapTo is driven before the next screen composition,
  // rather than leaving instant navigation one frame behind a LaunchedEffect keyed by frame.
  LaunchedEffect(
    runtime,
    source,
    motion,
    reducedMotion,
    seek,
    if (runtime == null) frame else null,
  ) {
    combine(
        runtime?.snapshots ?: flowOf(null),
        snapshotFlow {
          val backPreview = seek?.preview?.takeIf { it.stackChange?.id == source.id }
          Triple(
            backPreview,
            if (backPreview != null) seek.progress else 0f,
            if (backPreview != null) seek.result else null,
          )
        },
      ) { snapshot, gesture ->
        snapshot to gesture
      }
      .collectLatest { (snapshot, gesture) ->
        val (backPreview, progress, result) = gesture
        val current = snapshot?.let { stackFrame(runtime, it, source.id) } ?: frame
        val target = backPreview?.let { stackFrame(runtime, it, source.id) } ?: current
        val kind =
          resolveStackAnimation(
              source.stackTransition,
              (backPreview ?: snapshot)?.stackChange?.takeIf { it.id == source.id },
              motion,
              reducedMotion,
            )
            .kind
        inFlight = true
        try {
          if (backPreview == null) {
            if (kind == StackTransitionKind.None) state.snapTo(current)
            else state.animateTo(current)
          } else
            when (result) {
              null -> if (kind != StackTransitionKind.None) state.seekTo(progress, target)
              true -> {
                if (kind == StackTransitionKind.None) state.snapTo(target)
                else state.animateTo(target)
                seek?.clear()
              }
              false -> {
                if (kind == StackTransitionKind.None) state.snapTo(current)
                else state.animateTo(current)
                seek?.clear()
              }
            }
        } finally {
          inFlight = false
        }
      }
  }
  transition.AnimatedContent(
    modifier,
    transitionSpec = {
      stackTransform(kind, animation.direction, rtl, animation.fadeThrough)
    },
    contentKey = { it.key },
    contentAlignment = alignment,
  ) {
    draw(it)
  }
}

private fun stackFrame(
  runtime: PrototypeRuntime?,
  snapshot: PrototypeRuntimeSnapshot,
  id: String,
): StackFrame? {
  if (runtime == null) return null
  fun find(node: PrototypeRenderNode): PrototypeRenderNode? =
    if ((node.source as? PrototypeStackNode)?.id == id) node
    else node.children.firstNotNullOfOrNull(::find)
  val stack = find(runtime.renderModel(snapshot).root) ?: return null
  val path = snapshot.stacks.getValue(id).path
  return stack.children.firstOrNull()?.let { StackFrame(path.lastIndex, path.last(), it) }
}

private fun stackTransform(
  kind: StackTransitionKind,
  direction: String,
  rtl: Boolean,
  fadeThrough: Boolean = false,
): ContentTransform {
  val timing = tween<Float>(STACK_DURATION_MS, easing = LinearOutSlowInEasing)
  return when (kind) {
    StackTransitionKind.None -> EnterTransition.None togetherWith ExitTransition.None
    StackTransitionKind.Fade ->
      if (fadeThrough) {
        fadeIn(tween(STACK_FADE_THROUGH_MS, delayMillis = STACK_FADE_THROUGH_MS)) togetherWith
          fadeOut(tween(STACK_FADE_THROUGH_MS))
      } else fadeIn(timing) togetherWith fadeOut(timing)
    StackTransitionKind.Slide -> {
      val pop = direction == "pop"
      val slideTiming =
        tween<androidx.compose.ui.unit.IntOffset>(STACK_DURATION_MS, easing = LinearOutSlowInEasing)
      (slideInHorizontally(slideTiming) { width ->
          stackEnterOffset(width, pop, rtl)
        } togetherWith
          slideOutHorizontally(slideTiming) { width ->
            stackExitOffset(width, pop, rtl)
          })
        .apply { targetContentZIndex = if (pop) -1f else 1f }
    }
  }.let { transform ->
    ContentTransform(
      transform.targetContentEnter,
      transform.initialContentExit,
      transform.targetContentZIndex,
      sizeTransform = null,
    )
  }
}
