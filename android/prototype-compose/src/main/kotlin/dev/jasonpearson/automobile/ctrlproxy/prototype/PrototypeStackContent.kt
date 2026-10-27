package dev.jasonpearson.automobile.ctrlproxy.prototype

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.rememberScrollState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import dev.jasonpearson.automobile.protocol.PrototypeStackNode
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf

private const val STACK_DURATION_MS = 300
private const val STACK_FADE_THROUGH_MS = STACK_DURATION_MS / 2
private const val STACK_SPATIAL_DURATION_MS = 300
private const val STACK_EFFECTS_DURATION_MS = 150

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
  val reducedMotion = LocalPrototypeMotionProfile.current == PrototypeMotionProfile.REDUCED
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
  val axisDistance = with(LocalDensity.current) { 30.dp.roundToPx() }
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
    stackGestureFlow(runtime, seek, source.id).collectLatest { (snapshot, gesture) ->
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
        settleStack(
          state,
          kind,
          StackSettle(current, target, backPreview != null, progress, result),
          seek,
        )
      } finally {
        inFlight = false
      }
    }
  }
  transition.AnimatedContent(
    modifier,
    transitionSpec = {
      stackTransform(kind, animation.direction, rtl, animation.fadeThrough, axisDistance)
    },
    contentKey = { it.key },
    contentAlignment = alignment,
  ) {
    draw(it)
  }
}

private data class StackSettle(
  val current: StackFrame,
  val target: StackFrame,
  val previewing: Boolean,
  val progress: Float,
  val result: Boolean?,
)

private fun stackGestureFlow(
  runtime: PrototypeRuntime?,
  seek: PrototypeBackSeek?,
  stackId: String,
) =
  combine(
    runtime?.snapshots ?: flowOf(null),
    snapshotFlow {
      val backPreview = seek?.preview?.takeIf { it.stackChange?.id == stackId }
      Triple(
        backPreview,
        if (backPreview != null) seek.progress else 0f,
        if (backPreview != null) seek.result else null,
      )
    },
  ) { snapshot, gesture ->
    snapshot to gesture
  }

private suspend fun settleStack(
  state: SeekableTransitionState<StackFrame>,
  kind: StackTransitionKind,
  settle: StackSettle,
  seek: PrototypeBackSeek?,
) {
  val animated = kind != StackTransitionKind.None
  suspend fun go(frame: StackFrame) {
    if (animated) state.animateTo(frame) else state.snapTo(frame)
  }
  if (!settle.previewing) return go(settle.current)
  when (settle.result) {
    null -> if (animated) state.seekTo(settle.progress, settle.target)
    true -> {
      go(settle.target)
      seek?.clear()
    }
    false -> {
      go(settle.current)
      seek?.clear()
    }
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
  axisDistance: Int = 30,
): ContentTransform {
  val timing = tween<Float>(STACK_DURATION_MS, easing = LinearOutSlowInEasing)
  return when (kind) {
    StackTransitionKind.None -> EnterTransition.None togetherWith ExitTransition.None
    StackTransitionKind.Fade ->
      if (fadeThrough) {
        fadeIn(
          tween(STACK_FADE_THROUGH_MS, delayMillis = STACK_FADE_THROUGH_MS),
        ) togetherWith fadeOut(tween(STACK_FADE_THROUGH_MS))
      } else fadeIn(timing) togetherWith fadeOut(timing)
    StackTransitionKind.FadeThrough ->
      (fadeIn(tween(STACK_EFFECTS_DURATION_MS, delayMillis = STACK_EFFECTS_DURATION_MS)) +
        scaleIn(
          tween(STACK_EFFECTS_DURATION_MS, delayMillis = STACK_EFFECTS_DURATION_MS),
          initialScale = 0.92f,
        )) togetherWith fadeOut(tween(STACK_EFFECTS_DURATION_MS))
    StackTransitionKind.SharedAxisX,
    StackTransitionKind.SharedAxisY ->
      stackAxisTransform(kind, direction == "pop", rtl, axisDistance)
    StackTransitionKind.Slide -> {
      val pop = direction == "pop"
      val slideTiming =
        tween<androidx.compose.ui.unit.IntOffset>(
          STACK_DURATION_MS,
          easing = LinearOutSlowInEasing,
        )
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

private fun stackAxisTransform(
  kind: StackTransitionKind,
  pop: Boolean,
  rtl: Boolean,
  distance: Int,
): ContentTransform {
  val sign = (if (pop) -1 else 1) * (if (kind == StackTransitionKind.SharedAxisX && rtl) -1 else 1)
  val timing =
    tween<androidx.compose.ui.unit.IntOffset>(
      STACK_SPATIAL_DURATION_MS,
      easing = LinearOutSlowInEasing,
    )
  val enter =
    if (kind == StackTransitionKind.SharedAxisX) slideInHorizontally(timing) { sign * distance }
    else slideInVertically(timing) { sign * distance }
  val exit =
    if (kind == StackTransitionKind.SharedAxisX) slideOutHorizontally(timing) { -sign * distance }
    else slideOutVertically(timing) { -sign * distance }
  return (enter + fadeIn(tween(STACK_EFFECTS_DURATION_MS))) togetherWith
    (exit + fadeOut(tween(STACK_EFFECTS_DURATION_MS)))
}
